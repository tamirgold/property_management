locals {
  environments = toset(["dev", "stage", "prod"])
  tags = {
    project   = var.prefix
    managedBy = "terraform"
  }
}

resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_container_registry" "main" {
  name                = replace("${var.prefix}acr", "-", "")
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Premium"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_key_vault" "main" {
  name                          = "${var.prefix}-kv"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  soft_delete_retention_days    = 30
  purge_protection_enabled      = true
  enabled_for_disk_encryption   = true
  enable_rbac_authorization     = true
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_user_assigned_identity" "github_deployer" {
  name                = "${var.prefix}-github-identity"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "workload" {
  name                = "${var.prefix}-workload-identity"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_kubernetes_cluster" "main" {
  name                = "${var.prefix}-aks"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = "${var.prefix}-dns"
  kubernetes_version  = var.kubernetes_version
  oidc_issuer_enabled = true
  workload_identity_enabled = true
  sku_tier = "Standard"
  tags     = local.tags

  default_node_pool {
    name                 = "system"
    vm_size              = var.aks_node_vm_size
    node_count           = var.aks_node_count
    os_disk_size_gb      = 128
    orchestrator_version = var.kubernetes_version
    type                 = "VirtualMachineScaleSets"
    auto_scaling_enabled = true
    min_count            = 3
    max_count            = 10
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin    = "azure"
    load_balancer_sku = "standard"
    outbound_type     = "loadBalancer"
  }

  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
  }
}

data "azurerm_client_config" "current" {}

resource "azurerm_role_assignment" "aks_kubelet_acr_pull" {
  principal_id         = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  role_definition_name = "AcrPull"
  scope                = azurerm_container_registry.main.id
}

resource "azurerm_role_assignment" "github_rg_contributor" {
  principal_id         = azurerm_user_assigned_identity.github_deployer.principal_id
  role_definition_name = "Contributor"
  scope                = azurerm_resource_group.main.id
}

resource "azurerm_role_assignment" "github_acr_push" {
  principal_id         = azurerm_user_assigned_identity.github_deployer.principal_id
  role_definition_name = "AcrPush"
  scope                = azurerm_container_registry.main.id
}

resource "azurerm_role_assignment" "github_aks_cluster_user" {
  principal_id         = azurerm_user_assigned_identity.github_deployer.principal_id
  role_definition_name = "Azure Kubernetes Service Cluster User Role"
  scope                = azurerm_kubernetes_cluster.main.id
}

resource "azurerm_role_assignment" "github_aks_cluster_admin" {
  principal_id         = azurerm_user_assigned_identity.github_deployer.principal_id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  scope                = azurerm_kubernetes_cluster.main.id
}

resource "azurerm_role_assignment" "github_kv_secrets_officer" {
  principal_id         = azurerm_user_assigned_identity.github_deployer.principal_id
  role_definition_name = "Key Vault Secrets Officer"
  scope                = azurerm_key_vault.main.id
}

resource "azurerm_role_assignment" "workload_kv_user" {
  principal_id         = azurerm_user_assigned_identity.workload.principal_id
  role_definition_name = "Key Vault Secrets User"
  scope                = azurerm_key_vault.main.id
}

resource "azurerm_federated_identity_credential" "github_actions" {
  name                = "github-actions-main"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.github_deployer.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:${var.github_owner}/${var.github_repository}:ref:refs/heads/${var.github_branch}"
}

resource "azurerm_federated_identity_credential" "workload_identity" {
  for_each            = local.environments
  name                = "workload-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.workload.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject             = "system:serviceaccount:${var.k8s_namespace_prefix}-${each.key}:${var.k8s_service_account_name}"
}

resource "azurerm_postgresql_flexible_server" "db" {
  for_each                      = local.environments
  name                          = "${var.prefix}-${each.key}-pg"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = var.postgres_location
  version                       = "16"
  delegated_subnet_id           = null
  private_dns_zone_id           = null
  public_network_access_enabled = true
  administrator_login           = var.postgres_admin_username
  administrator_password        = var.postgres_admin_password
  storage_mb                    = var.postgres_storage_mb
  sku_name                      = var.postgres_sku_name
  zone                          = "1"
  tags                          = merge(local.tags, { environment = each.key })
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure_services" {
  for_each         = azurerm_postgresql_flexible_server.db
  name             = "allow-azure-services"
  server_id        = each.value.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  for_each  = azurerm_postgresql_flexible_server.db
  name      = var.postgres_database_name
  server_id = each.value.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

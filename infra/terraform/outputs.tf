output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.main.name
}

output "acr_name" {
  value = azurerm_container_registry.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "github_identity_client_id" {
  value = azurerm_user_assigned_identity.github_deployer.client_id
}

output "workload_identity_client_id" {
  value = azurerm_user_assigned_identity.workload.client_id
}

output "postgres_servers" {
  value = {
    for env, srv in azurerm_postgresql_flexible_server.db :
    env => {
      name     = srv.name
      fqdn     = srv.fqdn
      db_name  = azurerm_postgresql_flexible_server_database.app[env].name
      admin    = var.postgres_admin_username
    }
  }
  sensitive = true
}

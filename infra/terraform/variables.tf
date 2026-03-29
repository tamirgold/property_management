variable "prefix" {
  type        = string
  description = "Global prefix for resource names."
}

variable "location" {
  type        = string
  description = "Azure region for AKS/ACR/Key Vault."
  default     = "eastus"
}

variable "postgres_location" {
  type        = string
  description = "Azure region for PostgreSQL Flexible Server."
  default     = "centralus"
}

variable "resource_group_name" {
  type        = string
  description = "Resource group name."
}

variable "github_owner" {
  type        = string
  description = "GitHub organization or user name."
}

variable "github_repository" {
  type        = string
  description = "GitHub repository name."
}

variable "github_branch" {
  type        = string
  description = "GitHub branch allowed for OIDC federation."
  default     = "main"
}

variable "kubernetes_version" {
  type        = string
  description = "AKS Kubernetes version."
  default     = "1.33.0"
}

variable "aks_node_vm_size" {
  type        = string
  description = "VM size for AKS system node pool."
  default     = "Standard_D4s_v5"
}

variable "aks_node_count" {
  type        = number
  description = "Initial AKS system node count."
  default     = 3
}

variable "k8s_namespace_prefix" {
  type        = string
  description = "Namespace prefix for environments (dev/stage/prod)."
  default     = "app"
}

variable "k8s_service_account_name" {
  type        = string
  description = "Service account name used by workload pods."
  default     = "property-management-sa"
}

variable "postgres_admin_username" {
  type        = string
  description = "PostgreSQL admin username."
}

variable "postgres_admin_password" {
  type        = string
  description = "PostgreSQL admin password."
  sensitive   = true
}

variable "postgres_sku_name" {
  type        = string
  description = "PostgreSQL Flexible Server SKU."
  default     = "GP_Standard_D2s_v3"
}

variable "postgres_storage_mb" {
  type        = number
  description = "PostgreSQL storage in MB."
  default     = 32768
}

variable "postgres_database_name" {
  type        = string
  description = "Application database name."
  default     = "property_management"
}

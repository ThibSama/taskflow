locals {
  prefix      = "taskflow-${var.environment}"
  api_image   = "ghcr.io/${var.ghcr_owner}/taskflow-api:${var.image_tag}"
  front_image = "ghcr.io/${var.ghcr_owner}/taskflow-front:${var.image_tag}"

  db_password = var.db_password != null ? var.db_password : random_password.db.result
}

resource "docker_network" "this" {
  name = local.prefix
}

resource "docker_volume" "pgdata" {
  name = "${local.prefix}-pgdata"

  lifecycle {
    ignore_changes = [labels]
  }
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "docker_image" "db" {
  name         = "docker.io/library/postgres:16-alpine"
  keep_locally = true
}

resource "docker_image" "api" {
  name         = local.api_image
  keep_locally = true
}

resource "docker_image" "front" {
  name         = local.front_image
  keep_locally = true
}

resource "docker_container" "db" {
  name    = "${local.prefix}-db"
  image   = docker_image.db.image_id
  restart = "unless-stopped"

  env = [
    "POSTGRES_USER=taskflow",
    "POSTGRES_PASSWORD=${local.db_password}",
    "POSTGRES_DB=taskflow",
  ]

  volumes {
    volume_name    = docker_volume.pgdata.name
    container_path = "/var/lib/postgresql/data"
  }

  networks_advanced {
    name    = docker_network.this.id
    aliases = ["db"]
  }

  healthcheck {
    test     = ["CMD-SHELL", "pg_isready -U taskflow -d taskflow"]
    interval = "5s"
    timeout  = "3s"
    retries  = 10
  }

  wait         = true
  wait_timeout = 90
}

resource "docker_container" "api" {
  name    = "${local.prefix}-api"
  image   = docker_image.api.image_id
  restart = "unless-stopped"

  env = [
    "PORT=3000",
    "APP_ENV=${var.environment}",
    "DATABASE_URL=postgres://taskflow:${local.db_password}@db:5432/taskflow",
  ]

  networks_advanced {
    name    = docker_network.this.id
    aliases = ["api"]
  }

  healthcheck {
    test         = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1"]
    interval     = "5s"
    timeout      = "3s"
    retries      = 10
    start_period = "5s"
  }

  wait         = true
  wait_timeout = 90

  depends_on = [docker_container.db]
}

resource "docker_container" "front" {
  name         = "${local.prefix}-front"
  image        = docker_image.front.image_id
  restart      = "unless-stopped"
  wait_timeout = 90

  ports {
    internal = 80
    external = var.front_port
  }

  networks_advanced {
    name    = docker_network.this.id
    aliases = ["front"]
  }

  healthcheck {
    test         = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1/ || exit 1"]
    interval     = "10s"
    timeout      = "3s"
    retries      = 3
    start_period = "5s"
  }

  depends_on = [docker_container.api]
}

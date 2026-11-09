#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 VPS (Vultr, x86_64) for the Pactora backend.
# Images are built elsewhere and loaded here; this host only runs them.
# Idempotent: safe to run again.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Firewall first: SSH, HTTP, HTTPS, nothing else.
sudo apt-get update -y -q
sudo apt-get install -y -q ufw ca-certificates curl unattended-upgrades
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw allow 22/tcp >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null

# A little swap as a safety margin.
if ! swapon --show | grep -q /swap2g; then
  sudo fallocate -l 2G /swap2g && sudo chmod 600 /swap2g && sudo mkswap /swap2g >/dev/null && sudo swapon /swap2g
  grep -q '^/swap2g' /etc/fstab || echo '/swap2g none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# Docker Engine + compose plugin, from Docker's own repository.
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  # A release newer than Docker's repository falls back to 24.04 (noble).
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  curl -fsI "https://download.docker.com/linux/ubuntu/dists/$CODENAME/Release" >/dev/null 2>&1 || CODENAME=noble
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y -q
  sudo apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo systemctl enable --now docker
fi

# Docker publishes ports past ufw; our compose publishes only Caddy's 80/443,
# so that is the intended exposure. Automatic security updates on.
sudo dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

mkdir -p "$HOME/pactora"
echo "bootstrap done: $(sudo docker --version); ufw: $(sudo ufw status | head -1)"

#!/bin/bash
# NBA 2K20 VPS Setup + Deploy Script
# Run on a fresh Ubuntu 22.04 VPS as root:
#   bash setup.sh

set -e
echo "=== NBA 2K20 Private Server Setup ==="

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs openssl

# PM2 (keeps server alive on reboot)
npm install -g pm2

# Open ports
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw allow 20055/tcp
ufw allow 26135/tcp
ufw allow 30217/tcp
ufw allow 45323/tcp
ufw --force enable

# Create server dir
mkdir -p /opt/2k20-server
cp server.js /opt/2k20-server/
cp package.json /opt/2k20-server/

cd /opt/2k20-server

# Generate self-signed TLS cert (for HTTPS spoof)
openssl req -x509 -newkey rsa:2048 -keyout cert.key -out cert.pem -days 3650 -nodes \
  -subj "/CN=*.2ksports.com/O=2K/C=US" \
  -addext "subjectAltName=DNS:*.2ksports.com,DNS:*.2k.com,DNS:*.nba2k.com,DNS:nba2k.com"

# Install dependencies
npm install --omit=dev

# Start with PM2
pm2 start server.js --name 2k20-server --restart-delay 3000
pm2 save
pm2 startup | tail -1 | bash

echo ""
echo "=== DONE ==="
echo "Server is running. Your VPS public IP is:"
curl -s ifconfig.me
echo ""
echo "Put that IP in Covid20Redirect.dll config or update main.js:"
echo "  p20: { ..., host: 'YOUR_VPS_IP' }"

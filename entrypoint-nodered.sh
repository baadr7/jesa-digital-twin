#!/bin/sh
# JESA Node-RED entrypoint wrapper
# Symlinks pre-built node_modules from /opt/nodered-modules into /data
# and ensures OPC UA PKI client certificates exist.

set -e

# Create symlink for node_modules if not already present
if [ ! -d /data/node_modules ] && [ ! -L /data/node_modules ]; then
  echo "[entrypoint] Linking pre-built modules into /data/node_modules ..."
  ln -s /opt/nodered-modules/node_modules /data/node_modules
elif [ -L /data/node_modules ]; then
  echo "[entrypoint] node_modules symlink already present."
elif [ -d /data/node_modules ]; then
  echo "[entrypoint] node_modules directory exists - using as-is."
fi

# Ensure package.json is present
if [ ! -f /data/package.json ]; then
  cp /opt/nodered-modules/package.json /data/package.json
fi

# Ensure OPC UA PKI certificates exist
PKI_CERTS_DIR="/usr/src/node-red/.config/node-red-opcua-nodejs/PKI/own/certs"
PKI_KEY_DIR="/usr/src/node-red/.config/node-red-opcua-nodejs/PKI/own/private"
mkdir -p "$PKI_CERTS_DIR" "$PKI_KEY_DIR"

if [ ! -f "$PKI_CERTS_DIR/client_certificate.pem" ] || [ ! -f "$PKI_KEY_DIR/private_key.pem" ]; then
  echo "[entrypoint] Generating self-signed OPC UA client certificates ..."
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$PKI_KEY_DIR/private_key.pem" \
    -out "$PKI_CERTS_DIR/client_certificate.pem" \
    -days 3650 -nodes -subj '/CN=NodeOPCUA-Client' 2>/dev/null || true
fi

# Hand off to Node-RED via exec
exec "$@"

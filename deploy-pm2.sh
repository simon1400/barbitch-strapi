#!/bin/bash

# Deployment script for Barbitch Strapi with PM2
# Usage: ./deploy-pm2.sh

set -e

echo "🚀 Starting Barbitch Strapi deployment with PM2..."

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if running on server
if [ ! -d "/opt/barbitch-strapi" ]; then
    echo -e "${RED}❌ Error: This script should run on the server${NC}"
    echo "Run this script in /opt/barbitch-strapi directory"
    exit 1
fi

cd /opt/barbitch-strapi

echo -e "${BLUE}📦 Installing dependencies...${NC}"
yarn install --production=false

echo -e "${BLUE}🏗️  Building Strapi admin panel...${NC}"
yarn build

echo -e "${BLUE}🔄 Restarting PM2 process...${NC}"
if pm2 list | grep -q "barbitch-strapi"; then
    echo "Restarting existing process..."
    pm2 restart barbitch-strapi
else
    echo "Starting new PM2 process..."
    pm2 start ecosystem.config.js
fi

echo -e "${BLUE}💾 Saving PM2 configuration...${NC}"
pm2 save

echo -e "${GREEN}✅ Deployment completed successfully!${NC}"
echo ""
echo -e "${BLUE}📊 PM2 Status:${NC}"
pm2 list

echo ""
echo -e "${BLUE}📝 View logs with:${NC}"
echo "pm2 logs barbitch-strapi"

# Deployment Guide for DigitalOcean App Platform

## Prerequisites
- GitHub repository with your code
- DigitalOcean account
- Database already set up (as configured in api.js)

## Option 1: Deploy via DigitalOcean Dashboard

1. **Go to DigitalOcean Apps**
   - Login to your DigitalOcean account
   - Navigate to Apps in the sidebar
   - Click "Create App"

2. **Connect Your Repository**
   - Choose GitHub as your source
   - Select your repository containing this API code
   - Choose the main/master branch

3. **Configure Your App**
   - App name: `anon-api`
   - Resource type: Service
   - Source directory: `/` (root)
   - Build command: `npm install`
   - Run command: `npm start`
   - Environment: Node.js
   - Instance size: Basic ($5/month)

4. **Environment Variables** (Required for production)
   - Set these environment variables in your DigitalOcean App Platform:
   - DB_HOST=your-database-host
   - DB_USER=your-database-user
   - DB_PASSWORD=your-database-password
   - DB_NAME=your-database-name
   - DB_PORT=your-database-port
   - DB_SSL=true (for SSL connections)

5. **Deploy**
   - Review your settings
   - Click "Create Resources"
   - Wait for deployment to complete (5-10 minutes)

## Option 2: Deploy via doctl CLI

1. **Install doctl CLI**
   ```bash
   # On macOS
   brew install doctl
   
   # On Linux/Windows, download from:
   # https://github.com/digitalocean/doctl/releases
   ```

2. **Authenticate**
   ```bash
   doctl auth init
   ```

3. **Deploy**
   ```bash
   doctl apps create --spec app.yaml
   ```

## Post-Deployment

1. **Get your app URL**
   - Your app will be available at: `https://your-app-name.ondigitalocean.app`
   - Test the API endpoints:
     - `GET /api/dashboard/stats`
     - `GET /api/users`
     - etc.

2. **Configure CORS** (if needed)
   - Update the CORS configuration in api.js
   - Add your frontend domain to the allowed origins

3. **Set up Custom Domain** (optional)
   - In the DigitalOcean dashboard, go to your app settings
   - Add a custom domain in the "Domains" section

## API Endpoints

Once deployed, your API will be available at:
- `GET /api/dashboard/stats` - Dashboard statistics
- `GET /api/users` - Get all users with pagination
- `GET /api/users/:identifier` - Get user details
- `GET /api/conversations` - Get all conversations
- `GET /api/conversations/:conversationId` - Get conversation details
- `GET /api/messages` - Get all messages
- `GET /api/users/:userId/conversations` - Get user conversations
- `GET /api/users/search/:query` - Search users
- `GET /api/activity/recent` - Get recent activity
- `GET /api/analytics/usage` - Get usage analytics

## Monitoring

- Monitor your app in the DigitalOcean dashboard
- View logs, metrics, and resource usage
- Set up alerts for downtime or high resource usage
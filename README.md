
# zoterodav - Self-Deployable WebDAV for Zotero

## How to Setup

https://bookodav.joshuarodrigues.dev/

## Features
 
- 10GB free storage tier with R2  
- Basic authentication protection  
- Serverless architecture with minimal maintenance  
- Cross-platform WebDAV client support  

## Implementation Overview

```plaintext
┌─────────────┐        ┌──────────────┐        ┌─────────────┐
│    Client   │  HTTP  │  Cloudflare  │ R2 API │ R2 Storage  │
│   (Zotero)  │◄──────►│    Worker    │◄──────►│ (zoterodav) │
└─────────────┘        └──────────────┘        └─────────────┘
```



## Integration

```yaml
WebDAV:
  URL: https://[worker-subdomain].workers.dev
  Username: [your-username]
  Password: [your-password]
```
## Cost Structure (Cloudflare)

| Service         | Free Tier       | Paid Tier          |
|-----------------|-----------------|--------------------|
| R2 Storage      | 10GB            | $0.015/GB-month    |
| Requests        | 100,000/day     | $0.15/million      |


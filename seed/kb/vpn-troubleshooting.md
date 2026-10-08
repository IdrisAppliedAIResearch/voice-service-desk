---
title: Troubleshoot VPN connection problems
category: Network
tags: [vpn, troubleshooting, globalprotect]
updated: 2025-08-11
---
Most GlobalProtect VPN problems come from the internet connection, the portal address, or a missed Microsoft Authenticator request, and you can usually fix them yourself with the checks below.

1. Check your internet. If public websites do not load, restart your home router. On hotel or airport Wi-Fi, accept the network's terms page in a browser first.
2. Check the client. Cisco AnyConnect was retired on July 15, 2025 and no longer connects. Use GlobalProtect from Company Portal on Windows or Self Service on a Mac.
3. Check the portal address. Open GlobalProtect, select the gear icon, then Settings, and make sure the portal is gp.contoso-health.example.
4. Watch for the Authenticator request. If none arrives, open Microsoft Authenticator on your phone, make sure notifications are allowed and the phone is online, and try again. Type the number shown on your computer into the app.
5. Refresh the connection. If GlobalProtect says Connected but shared drives or internal sites do not open, select the gear icon, then Refresh Connection. If that fails, disconnect, restart, and connect again.
6. Check the clock. If your computer's time is several minutes off, sign-in can fail. Set the date and time to update automatically.

If you see Gateway not responding, or the connection drops every few minutes, collect logs before you call. Select the gear icon, then Settings, then Troubleshooting, then Collect Logs, and write down the exact error message and the time it happened.

While the VPN is not working, you can still use CH Remote Apps at remote.contoso-health.example, which does not need the VPN.

Still stuck? Call the service desk at extension 4357 (H E L P), or 555-0100 from an outside line, and have the error message ready.

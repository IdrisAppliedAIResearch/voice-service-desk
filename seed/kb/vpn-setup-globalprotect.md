---
title: Connect to the VPN with GlobalProtect
category: Network
tags: [vpn, remote-access, globalprotect]
updated: 2025-08-04
topic: vpn-setup
---
Use GlobalProtect to connect to the Contoso Health VPN when you work from home or travel and need internal systems such as shared drives or Remote Desktop to your office PC.

GlobalProtect replaced Cisco AnyConnect on July 15, 2025. AnyConnect is retired and no longer connects, so do not use it even if it is still on your computer.

1. Install GlobalProtect. On Windows, open Company Portal, search for GlobalProtect, and select Install. On a Mac, open Self Service, search for GlobalProtect, and select Install.
2. Connect to the internet, for example on your home Wi-Fi.
3. Open GlobalProtect from the globe icon in the Windows system tray near the clock, or in the Mac menu bar.
4. When asked for the portal address, enter gp.contoso-health.example and select Connect.
5. Sign in with your work email address and password.
6. Microsoft Authenticator sends a request to your phone. Type the number shown on your computer screen into the app and approve it.
7. When the status reads Connected and the globe icon shows a shield, you are on the VPN.
8. When you finish working, open GlobalProtect and select Disconnect.

You only enter the portal address the first time. After that, open GlobalProtect and select Connect.

The VPN sign-in needs Microsoft Authenticator, so set it up first if you have not already. Only approve requests you started yourself. If a request appears when you are not signing in, deny it and report it to the service desk.

You do not need the VPN for CH Remote Apps at remote.contoso-health.example, which works from a web browser.

Still stuck? See the article on troubleshooting VPN connection problems, or call the service desk at extension 4357 (H E L P), or 555-0100 from an outside line.

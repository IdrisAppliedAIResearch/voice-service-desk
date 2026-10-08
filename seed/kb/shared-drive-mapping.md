---
title: Map a shared drive on Windows or Mac
category: Access
tags: [shared-drive, mapping, s-drive]
updated: 2025-05-19
---
Your S: drive, which is your department share, and your H: drive, which is your home drive, normally appear when you sign in to a Contoso Health computer, and you can map them yourself if they are missing.

Department shares live under `\\files.contoso-health.example\shared\` followed by your department's folder name, for example `\\files.contoso-health.example\shared\Finance`. When you are off site, connect to the VPN first.

On Windows:

1. Open File Explorer and select This PC.
2. Select the three dots on the toolbar, then Map network drive.
3. Choose the drive letter S.
4. In the Folder box, type your department's path, for example `\\files.contoso-health.example\shared\Finance`.
5. Check Reconnect at sign-in and select Finish.

On a Mac:

1. In Finder, select Go, then Connect to Server.
2. Type `smb://files.contoso-health.example/shared/Finance`, using your own department's folder name, and select Connect.
3. If asked, sign in with your Contoso Health username and password and select Remember this password in my keychain.
4. To reconnect at every login, open System Settings, then General, then Login Items, and add the share under Open at Login.

If the drive maps but a folder says access denied, you need permission from the folder's data owner. Submit an Access Request at itportal.contoso-health.example, and sign out and back in after it is approved.

If the S: or H: drive shows a red X, it is disconnected. Connect to the VPN if you are off site, then open the drive again.

Still stuck? Call the service desk at extension 4357 (H E L P), or 555-0100 from an outside line, or open a ticket at itportal.contoso-health.example.

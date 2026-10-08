---
title: Add a printer on a Windows computer
category: Printing
tags: [printer, windows, followme]
updated: 2024-09-12
---
Contoso Health uses one secure print queue called FollowMe, so you add it once on your Windows computer and then pick up your printouts at any printer with your badge.

1. Make sure you are on the Contoso Health network, either on site or connected to the VPN.
2. Press the Windows key and R together to open the Run box.
3. Type `\\print.contoso-health.example\FollowMe` and press Enter.
4. Windows installs the printer driver, which can take a minute. When a print queue window opens, FollowMe is added and you can close the window.
5. To print, choose FollowMe in the print window of any application.

You can also add it in Settings. Open Settings, select Bluetooth and devices, then Printers and scanners, then Add device. Select Add manually, choose Select a shared printer by name, type the same path, `\\print.contoso-health.example\FollowMe`, and select Next.

To make FollowMe your default printer, open Printers and scanners, select FollowMe, and choose Set as default. If Windows keeps changing your default, turn off Let Windows manage my default printer on the same page.

Jobs wait in the FollowMe queue for 24 hours. Release them by tapping your badge at any Contoso Health printer, as described in the article on releasing print jobs with your badge.

If you get an access denied or driver error, restart your computer and try again while on the Contoso Health network. If FollowMe is missing from the print window after it was added, remove it from Printers and scanners and add it again.

Still stuck? Call the service desk at extension 4357 (H E L P), or 555-0100 from an outside line, or open a ticket at itportal.contoso-health.example.

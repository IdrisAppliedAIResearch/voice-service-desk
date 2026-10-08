---
title: Add a printer on a Mac
category: Printing
tags: [printer, mac, followme]
updated: 2024-09-12
---
On a Contoso Health Mac, you add the FollowMe secure print queue from Self Service, then pick up your printouts at any printer with your badge.

1. Make sure you are on the Contoso Health network, either on site or connected to the VPN.
2. Open Self Service from the Applications folder or the Dock.
3. Search for FollowMe, and select Install next to FollowMe Printer. The driver and print queue install in a minute or two.
4. Print a test page. In any application, select File, then Print, choose FollowMe, and select Print.
5. The first time you print, your Mac asks for your Contoso Health username and password. Enter them, select Remember this password in my keychain, and select OK.

If Self Service is not working, add the queue by hand. Open System Settings, select Printers and Scanners, then Add Printer, Scanner, or Fax. Control-click the toolbar, choose Customize Toolbar, and drag the Advanced button onto it. Select Advanced, set Type to Windows printer via spoolss, enter `smb://print.contoso-health.example/FollowMe` as the URL, choose Generic PostScript Printer, and select Add.

After a password change, jobs can stop with the status Hold for Authentication. Open the print queue, select the refresh arrow next to the job, and enter your new password. If that does not work, open Keychain Access, delete the entry for print.contoso-health.example, and print again.

Jobs wait in the FollowMe queue for 24 hours. Release them by tapping your badge at any Contoso Health printer.

Still stuck? Call the service desk at extension 4357 (H E L P), or 555-0100 from an outside line, or open a ticket at itportal.contoso-health.example.

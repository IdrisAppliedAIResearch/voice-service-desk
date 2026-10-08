---
title: Laptop encryption with BitLocker and FileVault
category: Devices
tags: [encryption, bitlocker, filevault, laptop]
updated: 2024-10-01
---
Every Contoso Health laptop is encrypted, with BitLocker on Windows and FileVault on Mac, so patient and business data stay protected if a laptop is lost or stolen.

Intune turns encryption on automatically when a laptop is set up and keeps checking it. You cannot turn it off, and a laptop that is not encrypted loses access to email and other Contoso Health apps until it is fixed.

To check your status:

1. On Windows, open Control Panel, then BitLocker Drive Encryption. Drive C should say BitLocker on.
2. On a Mac, open System Settings, then Privacy and Security, and scroll to FileVault. It should say FileVault is turned on.

On a new laptop, encryption can take a few hours. Keep it plugged in, and keep working while it runs.

A Windows laptop sometimes asks for a BitLocker recovery key at startup, usually after a firmware update, a hardware repair, or a change to startup settings. Do not keep restarting. Instead:

1. Write down the Recovery key ID shown on the screen.
2. Call the service desk from another phone.
3. The service desk verifies your identity, then reads you the 48-digit recovery key that matches your key ID. Recovery keys are released only this way.
4. Type the key and press Enter. Windows starts normally.

A Mac that asks for a FileVault recovery key goes through the same process.

Never write a recovery key on the laptop or keep it in the laptop bag. If your laptop is lost or stolen, report it to the service desk right away so it can be locked and wiped remotely.

Still stuck? Call the service desk at extension 4357 (H E L P), or 555-0100 from an outside line, or open a ticket at itportal.contoso-health.example.

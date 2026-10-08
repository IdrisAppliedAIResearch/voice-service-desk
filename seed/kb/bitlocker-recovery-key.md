---
title: BitLocker recovery key prompt at startup
category: Devices
tags: [bitlocker, recovery-key, encryption]
updated: 2024-10-01
---
If your Windows laptop starts on a blue BitLocker recovery screen that asks for a 48-digit key, call the service desk, which releases recovery keys only after verifying your identity.

Every Contoso Health Windows laptop is encrypted with BitLocker. Intune enforces the encryption, so it cannot be turned off. The recovery screen usually appears after a BIOS or firmware update, a hardware repair, a different docking station, or a USB drive left plugged in at startup. It does not mean your files are lost.

1. Stop restarting the laptop and do not guess at the key.
2. Write down the Key ID shown on the recovery screen. The first eight characters are enough.
3. Call the service desk from another phone at extension 4357 (H E L P), or 555-0100 from outside. Recovery keys are never sent by email or text message.
4. The technician verifies your identity, matches the Key ID to your laptop, and reads the key to you in groups of six digits.
5. Type all 48 digits. The cursor moves to the next group by itself. If the number keys do not respond, use the function keys: F1 through F9 type 1 through 9, and F10 types 0.
6. Press Enter. Windows starts normally and your files are unchanged.

After a key has been used, Intune replaces it with a new one, so the key you were given will not work a second time. Never write a recovery key on the laptop or save it in a file, an email, or a chat.

If the recovery screen comes back on every restart, tell the service desk so a technician can repair the laptop's encryption settings.

Mac laptops are protected the same way with FileVault. If your Mac asks for a FileVault recovery key, the same rule applies: only the service desk can release it, after verifying your identity.

Still stuck? Call the service desk at extension 4357 (H E L P) or 555-0100 and have your Key ID ready.

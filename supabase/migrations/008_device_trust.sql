-- Trusted devices: "Lembrar neste dispositivo" belongs to the device, kept here, not only in the
-- browser. The app renews it each time the device is used (so a device in use never expires),
-- can revoke it from any other device, and records why the device was last signed out, so a
-- login asked for again can be explained (browser data wiped, session ended by the server…).
-- Run after 006_devices.sql. Without it the app keeps the trust in the browser alone, as before.

alter table public.devices add column if not exists trusted_until timestamptz;  -- null: not remembered
alter table public.devices add column if not exists revoked_at timestamptz;     -- set from Ajustes → Aparelhos
alter table public.devices add column if not exists kind text;                  -- 'celular' | 'computador'
alter table public.devices add column if not exists last_signout text;          -- why it last had to sign in again
alter table public.devices add column if not exists last_signin_at timestamptz;

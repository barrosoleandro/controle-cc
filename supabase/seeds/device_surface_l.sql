-- The SURFACE_L entry (run after 006_devices.sql). Re-runnable: it overwrites the entry.
--
-- Ollama 0.40.2 on this machine, read from /api/tags on 2026-10-10:
--   qwen3.5:4b          4.7B  2a654d98…  the one the app uses (verified: ~70 s for 4 merchants)
--   qwen2.5-coder:1.5b  1.5B  d7372fd8…  a code model, not suited to this app
-- The digests are what lets the app recognise this machine the first time it opens here;
-- the hardware is filled in by the app on that first visit.
--
-- The project has a single user (README: a dedicated Supabase project), so the entry goes
-- to every user in auth.users.

insert into public.devices (user_id, name, model_digests, ollama_url, ollama_model, ollama_enabled)
select id, 'SURFACE_L',
  array['2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd',
        'd7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668'],
  'http://localhost:11434', 'qwen3.5:4b', true
from auth.users
on conflict (user_id, name) do update set
  model_digests = excluded.model_digests,
  ollama_url = excluded.ollama_url,
  ollama_model = excluded.ollama_model,
  ollama_enabled = excluded.ollama_enabled;

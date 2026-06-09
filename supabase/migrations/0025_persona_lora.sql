-- Soul-like character training via fal.ai LoRA.
--
-- After uploading 5-15 reference images of a persona, we train a Flux LoRA
-- on fal.ai (~$2, 3-5 min). The trained LoRA weights URL is stored here
-- alongside the trigger word and timestamp. Image generation routes that
-- want consistent character output can opt-in by using fal-ai/flux-lora
-- with this lora_url as `loras: [{path, scale}]`.
--
-- Why store on personas (not a separate table):
--   - 1:1 relationship — each persona has one trained Soul at a time
--   - Re-training overwrites the previous URL; we don't need version history
--   - Avoids a join on every gen call

alter table public.personas
  add column if not exists lora_url text,
  add column if not exists lora_trigger_word text,
  add column if not exists lora_trained_at timestamptz,
  add column if not exists lora_training_request_id text,
  add column if not exists lora_training_status text; -- 'training' | 'done' | 'failed'

-- Index on training status so the dashboard can show in-flight trainings.
create index if not exists idx_personas_lora_training
  on public.personas(lora_training_status)
  where lora_training_status = 'training';

import { fal } from '@fal-ai/client';
fal.config({ credentials: '<ISI-DARI-FAL-DASHBOARD>' });
const blob = new Blob(['test'], { type: 'text/plain' });
try {
  await fal.storage.upload(blob);
} catch (e) {
  console.log('NAME:', e.name, 'MESSAGE:', e.message);
}

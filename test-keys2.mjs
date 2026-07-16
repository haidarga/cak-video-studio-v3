import fs from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const envFile = fs.readFileSync('.env.local', 'utf-8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
});

async function testR2() {
  console.log('Testing R2...');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY
    }
  });
  
  try {
    await client.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: 'test-ping',
      Body: 'ping',
    }));
    console.log('R2: SUCCESS');
  } catch (e) {
    console.log('R2 ERROR:', e.message);
  }
}

async function testFal() {
  console.log('Testing fal.ai...');
  try {
    const { fal } = await import('@fal-ai/client');
    fal.config({ credentials: env.FAL_KEY });
    const blob = new Blob(['test'], { type: 'text/plain' });
    const url = await fal.storage.upload(blob);
    console.log('FAL: SUCCESS', url);
  } catch (e) {
    console.log('FAL ERROR:', e.message);
  }
}

async function run() {
  await testR2();
  await testFal();
}
run();

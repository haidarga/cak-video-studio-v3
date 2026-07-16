import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

async function testR2BadKeys() {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://e3e0814ad6939bee57b29c5d86a1bcd9.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: '00000000000000000000000000000000',
      secretAccessKey: '0000000000000000000000000000000000000000000000000000000000000000'
    }
  });
  
  try {
    await client.send(new PutObjectCommand({
      Bucket: 'cak-video-refs',
      Key: 'test-ping',
      Body: 'ping',
    }));
  } catch (e) {
    console.log('R2 ERROR NAME:', e.name, 'MESSAGE:', e.message);
  }
}
testR2BadKeys();

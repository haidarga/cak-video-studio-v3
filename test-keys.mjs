import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

async function testR2() {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  
  try {
    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: 'test-key',
      Body: 'test',
    }));
    console.log('R2: Success');
  } catch (e) {
    console.log('R2 ERROR:', e.name, e.message);
  }
}

testR2();

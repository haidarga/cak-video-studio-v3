// HF Space hosts the Remotion render + ffmpeg stitch endpoints because Vercel
// serverless functions can't run Chrome/ffmpeg. Frontend on Vercel cross-origins
// to HF Space backend for those two specific endpoints.
//
// Override per-deploy by setting NEXT_PUBLIC_HF_BACKEND in Vercel env.

export const HF_BACKEND =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_HF_BACKEND) ||
  'https://cahmul2-cak-video-studio-v2.hf.space'

export const apiUrl = (path) => HF_BACKEND + path

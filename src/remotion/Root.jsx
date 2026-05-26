import { Composition } from 'remotion'
import { CaptionedVideo } from './CaptionedVideo.jsx'
import { StudioVideo } from './StudioVideo.jsx'

const FPS = 30
const meta = ({ props }) => ({
  durationInFrames: Math.max(1, Math.round((props.durationSec || 10) * FPS)),
  width: props.width || 1080,
  height: props.height || 1920,
})

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="CaptionedVideo"
        component={CaptionedVideo}
        durationInFrames={300}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{ videoUrl: '', captions: [], capStyle: {}, durationSec: 10, width: 1080, height: 1920 }}
        calculateMetadata={meta}
      />
      <Composition
        id="StudioVideo"
        component={StudioVideo}
        durationInFrames={300}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{ clips: [], captions: [], capStyle: {}, audio: null, durationSec: 10, width: 1080, height: 1920 }}
        calculateMetadata={meta}
      />
    </>
  )
}

import { describe, it, expect } from 'vitest'
import { sanitize, sanitizeLayers, compileImagePrompt, compileVideoPrompt, enrichLighting, inferSceneType, motionRealismFor } from './prompt-compiler.js'

describe('sanitize — contradiction engine', () => {
  it('drops cinematic language on phone presets', () => {
    expect(sanitize('A cinematic shot', { cameraId: 'samsung_a13_candid' })).toBe('A shot')
    expect(sanitize('ARRI Alexa look', { cameraId: 'iphone_15_clean' })).toBe('look')
  })

  it('drops pro-photo language on candid/casual presets', () => {
    expect(sanitize('sharp focus everywhere', { cameraId: 'samsung_a13_candid' })).toBe('everywhere')
  })

  it('drops wasted award/marketing tokens unconditionally', () => {
    expect(sanitize('Roger Deakins masterpiece', { cameraId: 'studio_tvc' })).toBe('masterpiece')
    expect(sanitize('scroll-stopping content', {})).toBe('content')
  })

  it('drops vertical-framing token when AR is horizontal', () => {
    expect(sanitize('vertical 9:16 phone aesthetic look', { ar: '16:9' })).toBe('look')
  })

  it('drops product-packaging language when skipProduct', () => {
    expect(sanitize('show accurate product packaging clearly', { skipProduct: true })).toBe('show clearly')
  })

  it('keeps the token when the rule is NOT triggered', () => {
    // cinematic rule does not list studio_tvc → keep it
    expect(sanitize('A cinematic shot', { cameraId: 'studio_tvc' })).toBe('A cinematic shot')
  })

  it('returns empty string for falsy input', () => {
    expect(sanitize('', {})).toBe('')
    expect(sanitize(null, {})).toBe('')
  })
})

describe('sanitizeLayers — proactive remove + inject (no vacuum)', () => {
  it('removes studio lighting on a phone preset AND injects directional window light', () => {
    const { cleaned, injects } = sanitizeLayers(['a shot with ring light and softbox'], { cameraId: 'samsung_a13_candid' })
    expect(cleaned.join(' ')).not.toMatch(/ring light|softbox/i)
    expect(injects.join(' ')).toMatch(/window light from one side/i)
  })
  it('injects "single continuous uncut take" when multi-scene removed under continuousShot', () => {
    const { injects } = sanitizeLayers(['9 panels of action'], { continuousShot: true })
    expect(injects.join(' ')).toMatch(/single continuous uncut take/i)
  })
  it('no inject when nothing was removed', () => {
    const { cleaned, injects } = sanitizeLayers(['a plain bedroom shot'], { cameraId: 'samsung_a13_candid' })
    expect(injects).toEqual([])
    expect(cleaned).toEqual(['a plain bedroom shot'])
  })
})

describe('compileImagePrompt', () => {
  const base = { identity: 'a woman', action: 'smiling at camera', camera: 'iphone_15_clean' }

  it('leads with the camera preset tokens (L1 highest priority)', () => {
    const out = compileImagePrompt(base)
    expect(out.split('\n')[0]).toContain('iPhone 15 Pro')
  })

  it('includes brand fidelity only when a product is present and not skipped', () => {
    expect(compileImagePrompt({ ...base, brand: 'UGREEN charger' })).toMatch(/CRITICAL PRODUCT FIDELITY/)
    expect(compileImagePrompt({ ...base, brand: 'UGREEN charger', skipProduct: true })).not.toMatch(/CRITICAL PRODUCT FIDELITY/)
  })

  it('adds the continuity line only with character refs', () => {
    expect(compileImagePrompt({ ...base, refsCount: 2 })).toMatch(/Keep character identity consistent/)
    expect(compileImagePrompt({ ...base, refsCount: 0 })).not.toMatch(/Keep character identity consistent/)
  })

  it('adds a STYLE REFERENCE anchor when style refs are present', () => {
    expect(compileImagePrompt({ ...base, styleRefsCount: 1 })).toMatch(/STYLE REFERENCE/)
  })

  it('emits the wardrobe edit imperative (L11) when wardrobe given', () => {
    const out = compileImagePrompt({ ...base, wardrobe: 'black hoodie' })
    expect(out).toMatch(/CHANGE the subjects' outfit to: black hoodie/)
    expect(out).toMatch(/Wardrobe: black hoodie/)
  })

  it('always states the AR composition', () => {
    expect(compileImagePrompt({ ...base, ar: '9:16' })).toMatch(/9:16 composition\./)
  })
})

describe('compileVideoPrompt', () => {
  it('passes camera tokens first when a preset is given (Direct Video)', () => {
    const out = compileVideoPrompt({ camera: 'samsung_a13_candid', action: 'walks forward', ar: '9:16' })
    expect(out.split('\n')[0]).toMatch(/Samsung Galaxy A-series/)
  })

  it('forbids on-screen text when noText is set', () => {
    expect(compileVideoPrompt({ action: 'x', noText: true })).toMatch(/no on-screen text/i)
  })

  it('injects a motion-blur realism baseline; keeps motion first + AR last', () => {
    const out = compileVideoPrompt({ action: 'pans across the room', ar: '16:9' })
    const lines = out.split('\n')
    expect(lines[0]).toBe('pans across the room')
    expect(out).toMatch(/motion blur/i)
    expect(lines[lines.length - 1]).toBe('16:9 composition.')
  })

  it('does NOT inject motion blur for animation presets (clean frames)', () => {
    const out = compileVideoPrompt({ action: 'walks forward', ar: '9:16', camera: 'animation_2d' })
    expect(out).not.toMatch(/motion blur/i)
  })

  it('picks scene-appropriate blur (beauty application)', () => {
    const out = compileVideoPrompt({ action: 'applying lip pencil to her lips', ar: '9:16' })
    expect(out).toMatch(/hands in motion with natural blur/i)
  })

  it('does NOT inject handheld motion blur into cinema presets (preset negates it)', () => {
    const out = compileVideoPrompt({ action: 'walks forward', ar: '9:16', camera: 'studio_tvc' })
    expect(out).not.toMatch(/motion blur/i)       // the contradiction we fixed
    expect(out).toMatch(/smooth controlled/i)     // cinema gets controlled motion instead
  })

  it('embeds product rigidity in the product-reveal motion line (anti-morph)', () => {
    const out = compileVideoPrompt({ action: 'she lifts the product to reveal it', ar: '9:16' })
    expect(out).toMatch(/RIGID/)
    expect(out).toMatch(/only the hand moves it/i)
  })

  it('honors a parser-tagged sceneType (reliable, not regex)', () => {
    // action text reads generic; the parser tag drives the right motion line
    const out = compileVideoPrompt({ action: 'a quiet moment', ar: '9:16', sceneType: 'beauty_application' })
    expect(out).toMatch(/hands in motion with natural blur/i)
  })

  it('injects spoken accent + relaxed pace when there is dialog (native-audio)', () => {
    const out = compileVideoPrompt({ action: 'she speaks', ar: '9:16', lang: 'Indonesian', dialect: 'Jawa medok', hasDialog: true, audioOn: true })
    expect(out).toMatch(/Jawa medok regional ACCENT/i)
    expect(out).toMatch(/keep the WORDS in Indonesian/i)
    expect(out).toMatch(/UNHURRIED pace/i)
  })
  it('no voice line when there is no dialog', () => {
    const out = compileVideoPrompt({ action: 'b-roll pan', ar: '9:16', dialect: 'Jawa medok', hasDialog: false })
    expect(out).not.toMatch(/Spoken audio/i)
  })
})

describe('compileVideoPrompt — storyboard mode (montage-aware, motion preserved)', () => {
  // No full phone-grunge dump, BUT the user's video_motion (cut/transition
  // intent) is preserved verbatim, and panels CUT by default (montage).
  const sb = {
    storyboard: true,
    camera: 'samsung_a13_candid',
    ar: '9:16',
    refsCount: 3,
    action: 'Quick cuts between candid moments of Emma and child playing, handheld camera movement',
    dialog: 'halo mak apa kabar',
    lang: 'Indonesian',
    dialect: 'Medanese (Batak)',
    hasDialog: true,
    audioOn: true,
    noText: true,
  }

  it('PRESERVES the user video_motion verbatim (cut/transition intent survives)', () => {
    const out = compileVideoPrompt(sb)
    expect(out).toMatch(/Quick cuts between candid moments/)
    expect(out).toMatch(/handheld camera movement/)
  })
  it('defaults to MONTAGE — hard cut between panels (this is what makes cut-to-cut happen)', () => {
    const out = compileVideoPrompt(sb)
    expect(out).toMatch(/HARD CUT between panels/i)
    expect(out).toMatch(/distinct shot/i)
    expect(out).not.toMatch(/ONE continuous unbroken take/i)
  })
  it('continuousShot=true → one unbroken take instead of cuts', () => {
    const out = compileVideoPrompt({ ...sb, continuousShot: true })
    expect(out).toMatch(/ONE continuous unbroken take/i)
    expect(out).not.toMatch(/HARD CUT between panels/i)
  })
  it('does NOT dump the full phone-grunge block', () => {
    const out = compileVideoPrompt(sb)
    expect(out).not.toMatch(/JPEG compression|crushed shadows|self-recorded phone cadence|unflattering candid/i)
  })
  it('keeps a short look clause + light secondary motion (not frozen)', () => {
    const out = compileVideoPrompt(sb)
    expect(out).toMatch(/handheld phone/i)
    expect(out).toMatch(/secondary motion|breathing|blinks/i)
  })
  it('keeps the dialog WORDS + accent + unhurried pace (audio must survive)', () => {
    const out = compileVideoPrompt(sb)
    expect(out).toMatch(/halo mak apa kabar/)
    expect(out).toMatch(/Medanese \(Batak\) regional ACCENT/i)
    expect(out).toMatch(/UNHURRIED pace/i)
  })
  it('states identity consistency + AR + no-text', () => {
    const out = compileVideoPrompt(sb)
    expect(out).toMatch(/no mid-video morphing/i)
    expect(out).toMatch(/9:16 composition\./)
    expect(out).toMatch(/no on-screen text/i)
  })
  it('animation storyboard keeps its style tokens but no skin/grunge', () => {
    const out = compileVideoPrompt({ ...sb, camera: 'animation_2d' })
    expect(out).not.toMatch(/skin texture|JPEG/i)
  })
})

describe('compileVideoPrompt — anti-drift/morph motion baseline', () => {
  it('adds a controlled-motion / no-morph clause for non-animation', () => {
    const out = compileVideoPrompt({ action: 'she walks fast and spins', ar: '9:16', camera: 'iphone_15_clean' })
    expect(out).toMatch(/controlled.*motion|no extreme/i)
    expect(out).toMatch(/no warping, melting, morphing|morphing/i)
  })
  it('skips it for animation (different physics)', () => {
    const out = compileVideoPrompt({ action: 'waving', ar: '9:16', camera: 'animation_2d' })
    expect(out).not.toMatch(/no warping, melting, morphing/i)
  })
})

describe('compileVideoPrompt — anti-collage when refs present (sheet → stacked bug)', () => {
  it('forbids split-screen / stacked / duplicate subject when refs are passed', () => {
    const out = compileVideoPrompt({ action: 'she speaks', ar: '9:16', refsCount: 3 })
    expect(out).toMatch(/single subject/i)
    expect(out).toMatch(/NOT a split-screen|NOT a collage|stacked/i)
    expect(out).toMatch(/do NOT reproduce their layout/i)
  })
  it('omits the anti-collage line when there are no refs', () => {
    const out = compileVideoPrompt({ action: 'she speaks', ar: '9:16', refsCount: 0 })
    expect(out).not.toMatch(/split-screen|reproduce their layout/i)
  })
})

describe('compileVideoPrompt — static camera intent (non-storyboard)', () => {
  // User wrote "camera fixed / no camera movement" but the iphone_15 preset
  // tokens ("clean handheld, motion blur from handheld movement") led the prompt
  // and overrode it → camera still moved. Static intent must win.
  const staticSpec = { camera: 'iphone_15_clean', ar: '9:16', action: 'The camera is fixed. Emma cuts fruit while speaking. No camera movement.' }

  it('strips the preset handheld/movement tokens when static is requested', () => {
    const out = compileVideoPrompt(staticSpec)
    expect(out).not.toMatch(/clean handheld/i)
    expect(out).not.toMatch(/motion blur from handheld movement/i)
  })
  it('adds a strong LOCKED-tripod override (recency beats the leading preset)', () => {
    const out = compileVideoPrompt(staticSpec)
    expect(out).toMatch(/LOCKED on a tripod/i)
    expect(out).toMatch(/no pan/i)
  })
  it('does NOT inject motionRealism handheld phrasing under static', () => {
    const out = compileVideoPrompt(staticSpec)
    expect(out).not.toMatch(/motion blur as the subject/i)
  })
  it('leaves handheld realism intact when NOT static', () => {
    const out = compileVideoPrompt({ camera: 'iphone_15_clean', ar: '9:16', action: 'Emma walks and talks to camera' })
    expect(out).not.toMatch(/LOCKED on a tripod/i)
    expect(out).toMatch(/clean handheld/i) // preset kept
  })
})

describe('motionRealismFor (camera-aware)', () => {
  it('phone → handheld blur + secondary motion', () => {
    expect(motionRealismFor('she speaks to camera', 'phone')).toMatch(/motion blur/i)
    expect(motionRealismFor('she speaks to camera', 'phone')).toMatch(/secondary motion|breathing/i)
  })
  it('cinema → smooth controlled, no motion blur', () => {
    const m = motionRealismFor('walks forward', 'cinema')
    expect(m).toMatch(/smooth controlled/i)
    expect(m).not.toMatch(/motion blur/i)
  })
  it('animation → empty (clean frames)', () => {
    expect(motionRealismFor('waving', 'animation')).toBe('')
  })
  it('defaults to phone when category omitted', () => {
    expect(motionRealismFor('something')).toMatch(/motion blur/i)
  })
})

describe('inferSceneType', () => {
  it('classifies by action verbs', () => {
    expect(inferSceneType('she is applying foundation')).toBe('beauty_application')
    expect(inferSceneType('character walks into frame')).toBe('walking_transition')
    expect(inferSceneType('b-roll of the room')).toBe('broll')
    expect(inferSceneType('she lifts the product to reveal it')).toBe('product_reveal')
    expect(inferSceneType('she speaks to camera and smiles')).toBe('talking_head')
    expect(inferSceneType('something unspecified')).toBe('default')
  })
})

describe('enrichLighting', () => {
  const phone = { category: 'phone' }
  it('injects directional light when the naskah named none', () => {
    expect(enrichLighting('bedroom', phone)).toMatch(/directional shadow/i)
    expect(enrichLighting('di taman', phone)).toMatch(/directional sunlight/i)
    expect(enrichLighting('pagi hari di kamar', phone)).toMatch(/morning window light/i)
  })
  it('stays out of the way when a light source is already specified', () => {
    expect(enrichLighting('harsh sunlight from the window', phone)).toBe('')
    expect(enrichLighting('golden hour rooftop', phone)).toBe('')
  })
  it('never enriches animation', () => {
    expect(enrichLighting('bedroom', { category: 'animation' })).toBe('')
  })
})

describe('compileImagePrompt — realism injection', () => {
  it('names concrete skin imperfection on phone presets (anti-waxy)', () => {
    const out = compileImagePrompt({ identity: 'a woman', action: 'smiling', camera: 'iphone_15_clean' })
    expect(out).toMatch(/visible skin pores/i)
    expect(out).toMatch(/mild facial asymmetry/i)
  })
  it('adds directional lighting line when environment lacks a light source', () => {
    const out = compileImagePrompt({ identity: 'a woman', action: 'smiling', camera: 'iphone_15_clean', environment: 'cozy bedroom' })
    expect(out).toMatch(/directional shadow|window light/i)
  })
  it('adds sun-kissed skin context for outdoor scenes', () => {
    const out = compileImagePrompt({ identity: 'a woman', action: 'smiling', camera: 'iphone_15_clean', environment: 'outdoor park' })
    expect(out).toMatch(/sun-kissed|sunburn flush/i)
  })
  it('keeps animation clean (no skin pores / no lighting injection)', () => {
    const out = compileImagePrompt({ identity: 'a mascot', action: 'waving', camera: 'animation_2d', environment: 'bedroom' })
    expect(out).not.toMatch(/visible skin pores/i)
    expect(out).not.toMatch(/directional shadow/i)
  })
})

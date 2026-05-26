// Caption fonts — loaded via @remotion/google-fonts (works in Player + render)
import { loadFont as loadInter } from '@remotion/google-fonts/Inter'
import { loadFont as loadMontserrat } from '@remotion/google-fonts/Montserrat'
import { loadFont as loadBebas } from '@remotion/google-fonts/BebasNeue'
import { loadFont as loadAnton } from '@remotion/google-fonts/Anton'
import { loadFont as loadPoppins } from '@remotion/google-fonts/Poppins'

export const FONTS = {
  Inter: loadInter().fontFamily,
  Montserrat: loadMontserrat().fontFamily,
  'Bebas Neue': loadBebas().fontFamily,
  Anton: loadAnton().fontFamily,
  Poppins: loadPoppins().fontFamily,
}

export const FONT_NAMES = Object.keys(FONTS)

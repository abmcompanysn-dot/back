'use client'

import { MotionConfig } from 'framer-motion'

// Honore le réglage "réduire les animations" du système d'exploitation pour
// toutes les animations framer-motion de l'app (WCAG 2.3.3) — un seul point
// de configuration plutôt que de gérer chaque motion.div individuellement.
export function MotionConfigProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}

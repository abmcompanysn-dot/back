# React Doctor — false positives

## `react-doctor/no-layout-property-animation` — enter/exit height reveal via AnimatePresence

**Files:** `components/miad/CheckoutPage.tsx` (accordion sections around lines 472, 596)

**Pattern:** `initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}` on a `motion.div`, wrapped in `<AnimatePresence>`.

**Why it's a false positive:** per the rule's own validation prompt — "an ENTER/EXIT transition (typically inside `<AnimatePresence>`, or initial+animate+exit) that animates height or width between 0 and the string 'auto'/'unset'/'100%'/'fit-content' — motion measures the target and runs a FLIP, so this is the intended, optimized pattern; SUPPRESS." The static rule can't see the FLIP semantics from the JSX alone, so it fires on a pattern framer-motion already optimizes. Verified 2026-07-10.

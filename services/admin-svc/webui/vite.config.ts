import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servi par admin-svc (Go) sous /admin — base doit matcher pour que les
// assets se résolvent correctement une fois le build embarqué.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
  },
})

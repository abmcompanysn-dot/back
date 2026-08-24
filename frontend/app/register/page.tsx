import { RegisterPage } from '@/components/miad/RegisterPage'

export const metadata = {
  title: 'Créer un compte — MIAD Market',
  description: 'Rejoignez la marketplace panafricaine MIAD Market. Inscription gratuite.',
}

export default function RegisterRoute() {
  return (
    <main className="min-h-screen bg-background">
      <RegisterPage />
    </main>
  )
}

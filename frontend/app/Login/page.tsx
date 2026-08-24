"use client"

import { LoginPage } from '@/components/miad/LoginPage'
import { useRouter } from 'next/navigation'

export default function LoginPageRoute() {
  const router = useRouter()

  const handleBack = () => {
    // Si on est sur une page isolée, on retourne à l'accueil
    if (window.history.length <= 1) {
      router.push('/')
    } else {
      router.back()
    }
  }

  const handleLoginSuccess = (type: 'buyer' | 'vendor') => {
    // Retourner là où l'utilisateur était, sinon dashboard
    const returnPath = sessionStorage.getItem('miad_login_return_url')
    sessionStorage.removeItem('miad_login_return_url')
    if (returnPath) {
      router.push(returnPath)
    } else {
      const target = type === 'vendor' ? '/?view=vendorDashboard' : '/?view=clientDashboard'
      router.push(target)
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <LoginPage onBack={handleBack} onLoginSuccess={handleLoginSuccess} />
    </main>
  )
}

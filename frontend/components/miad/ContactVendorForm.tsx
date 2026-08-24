"use client"

import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Loader2, Phone, MessageSquare } from 'lucide-react';

interface ContactVendorFormProps {
  vendorId: string;
  vendorName: string;
  productId?: string;
  productName?: string;
  onClose: () => void;
}

export function ContactVendorForm({ vendorId, productId, productName, onClose }: ContactVendorFormProps) {
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const token = localStorage.getItem('miad_token');
      if (!token) {
        toast.error("Vous devez être connecté pour envoyer un message.");
        onClose();
        return;
      }

      // Le numéro est intégré dans le corps du message
      const fullMessage = phone ? `📞 ${phone}\n\n${message}` : message;
      const subject = productName ? `Question sur : ${productName}` : `Contact via MIAD Market`;

      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          recipientId: vendorId,
          productId,
          subject,
          message: fullMessage,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Échec de l'envoi du message.");

      toast.success("Votre message a été envoyé au vendeur !");
      onClose();
    } catch (error: any) {
      toast.error(error.message || "Une erreur est survenue lors de l'envoi.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Numéro de téléphone */}
      <div className="relative">
        <Phone size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          type="tel"
          placeholder="Votre numéro de téléphone"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          className="pl-9"
          required
        />
      </div>

      {/* Message */}
      <div className="relative">
        <MessageSquare size={15} className="absolute left-3 top-3 text-muted-foreground pointer-events-none" />
        <Textarea
          placeholder="Votre message..."
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={5}
          className="pl-9 resize-none"
          required
        />
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting && <Loader2 size={15} className="animate-spin mr-2" />}
        Envoyer le message
      </Button>
    </form>
  );
}

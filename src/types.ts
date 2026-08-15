import type { BookingStatus } from './domain/status.js';

export interface Administrator {
  id: string;
  email: string;
  display_name: string;
}

export interface EnquiryRow {
  id: string;
  reference: string;
  status: string;
  full_name: string;
  email: string;
  phone: string | null;
  requested_check_in: string | null;
  requested_check_out: string | null;
  guests_count: number | null;
  message: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface BookingRow {
  id: string;
  reference: string;
  property_id: string;
  enquiry_id: string | null;
  primary_guest_id: string;
  status: BookingStatus;
  check_in: string;
  check_out: string;
  guests_count: number;
  currency: string;
  rental_price_minor: number;
  amount_due_minor: number;
  remaining_balance_minor: number;
  security_deposit_minor: number;
  tourist_tax_minor: number;
  payment_deadline: string;
  cancellation_terms: string;
  special_conditions: string;
  version: number;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  cancelled_at: string | null;
}

export interface GuestRow {
  id: string;
  legal_name: string;
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string | null;
  postal_code: string;
  city: string;
  region: string | null;
  country: string;
}

export interface AgreementRow {
  id: string;
  booking_id: string;
  version: number;
  template_id: string;
  template_version: string;
  status: string;
  generated_at: string;
  rendered_html: string;
  template_data_json: string;
  page_count: number;
  document_hash: string;
  unsigned_pdf_path: string;
  signed_pdf_path: string | null;
  signed_document_hash: string | null;
  provider: string;
  provider_document_id: string | null;
  owner_signed_at: string | null;
  guest_signed_at: string | null;
  completed_at: string | null;
  invalidated_at: string | null;
  invalidated_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  booking_id: string;
  agreement_id: string;
  agreement_version: number;
  provider: string;
  payment_method: 'CARD' | 'BANK_TRANSFER' | null;
  bank_transfer_selected_at: string | null;
  bank_transfer_confirmed_at: string | null;
  purpose: 'INITIAL' | 'BALANCE';
  due_date: string | null;
  status: string;
  amount_minor: number;
  refunded_minor: number;
  currency: string;
  checkout_session_id: string | null;
  checkout_url: string | null;
  payment_intent_id: string | null;
  charge_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  refunded_at: string | null;
}

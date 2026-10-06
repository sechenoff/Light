import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe,it,expect,vi,beforeEach } from 'vitest';
vi.mock('../../../lib/api',()=>({apiFetch:vi.fn()}));
vi.mock('../../ToastProvider',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {apiFetch} from '../../../lib/api';
import {RecordPaymentModal} from '../RecordPaymentModal';
const ctx={id:'b1',projectName:'Test',client:{name:'Client'},finalAmount:'100',amountPaid:'0',amountOutstanding:'100'};
beforeEach(()=>vi.clearAllMocks());
// Окно спрашивает превью «Разнести по продолжениям» — отвечаем «семьи нет»,
// а платёжные запросы считаем отдельно, чтобы таймер превью не сбивал порядок.
const isPreview=(url:unknown)=>String(url).includes('/api/payments/family-preview');
const NO_FAMILY={members:1,rows:[],parts:[]};
const paymentCalls=()=>vi.mocked(apiFetch).mock.calls.filter(([url])=>url==='/api/payments');
describe('Payment submit',()=>{
 it('uses Moscow time and the same idempotency key after uncertain network failure',async()=>{
  let posts=0;
  vi.mocked(apiFetch).mockImplementation(async (url:unknown)=>{ if(isPreview(url)) return NO_FAMILY as never; posts+=1; if(posts===1) throw new Error('Network'); return {} as never; });
  const {container}=render(<RecordPaymentModal open defaultBookingId="b1" bookingContext={ctx} onClose={()=>{}} onCreated={()=>{}} />);
  fireEvent.change(container.querySelector('input[type="datetime-local"]')!,{target:{value:'2026-09-17T15:30'}});
  fireEvent.click(screen.getByRole('button',{name:'Записать платёж'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Записать платёж'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Записать платёж'}));
  await waitFor(()=>expect(paymentCalls()).toHaveLength(2));
  const a=JSON.parse(paymentCalls()[0][1]!.body as string), b=JSON.parse(paymentCalls()[1][1]!.body as string);
  expect(a.requestKey).toMatch(/^[a-f0-9-]{36}$/);expect(a.requestKey).toBe(b.requestKey);expect(a.receivedAt).toBe('2026-09-17T12:30:00.000Z');
 });
 it('prevents double click while a payment is in flight',async()=>{
  let release: (v:unknown)=>void=()=>{};vi.mocked(apiFetch).mockImplementation((url:unknown)=>isPreview(url)?Promise.resolve(NO_FAMILY as never):new Promise(r=>{release=r;}));
  render(<RecordPaymentModal open defaultBookingId="b1" bookingContext={ctx} onClose={()=>{}} onCreated={()=>{}} />);
  const submit=screen.getByRole('button',{name:'Записать платёж'});fireEvent.click(submit);fireEvent.click(submit);
  expect(paymentCalls()).toHaveLength(1);release({});await waitFor(()=>expect(submit).toBeEnabled());
 });
});

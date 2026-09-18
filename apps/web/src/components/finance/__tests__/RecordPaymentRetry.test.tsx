import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe,it,expect,vi,beforeEach } from 'vitest';
vi.mock('../../../lib/api',()=>({apiFetch:vi.fn()}));
vi.mock('../../ToastProvider',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {apiFetch} from '../../../lib/api';
import {RecordPaymentModal} from '../RecordPaymentModal';
const ctx={id:'b1',projectName:'Test',client:{name:'Client'},finalAmount:'100',amountPaid:'0',amountOutstanding:'100'};
beforeEach(()=>vi.clearAllMocks());
describe('Payment submit',()=>{
 it('uses Moscow time and the same idempotency key after uncertain network failure',async()=>{
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network')).mockResolvedValueOnce({});
  const {container}=render(<RecordPaymentModal open defaultBookingId="b1" bookingContext={ctx} onClose={()=>{}} onCreated={()=>{}} />);
  fireEvent.change(container.querySelector('input[type="datetime-local"]')!,{target:{value:'2026-09-17T15:30'}});
  fireEvent.click(screen.getByRole('button',{name:'Записать платёж'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Записать платёж'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Записать платёж'}));
  await waitFor(()=>expect(apiFetch).toHaveBeenCalledTimes(2));
  const a=JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string), b=JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]!.body as string);
  expect(a.requestKey).toMatch(/^[a-f0-9-]{36}$/);expect(a.requestKey).toBe(b.requestKey);expect(a.receivedAt).toBe('2026-09-17T12:30:00.000Z');
 });
 it('prevents double click while a payment is in flight',async()=>{
  let release: (v:unknown)=>void=()=>{};vi.mocked(apiFetch).mockImplementation(()=>new Promise(r=>{release=r;}));
  render(<RecordPaymentModal open defaultBookingId="b1" bookingContext={ctx} onClose={()=>{}} onCreated={()=>{}} />);
  const submit=screen.getByRole('button',{name:'Записать платёж'});fireEvent.click(submit);fireEvent.click(submit);
  expect(apiFetch).toHaveBeenCalledTimes(1);release({});await waitFor(()=>expect(submit).toBeEnabled());
 });
});

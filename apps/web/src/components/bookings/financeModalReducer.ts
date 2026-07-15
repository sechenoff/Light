// Состояние шести финансовых модалок карточки брони (фаза 4.5): вместо шести
// разрозненных useState — один reducer. Каждая модалка независима; действия
// open*/close* — единственный способ её переключить (искать по типу действия
// проще, чем по шести сеттерам).

export type FinanceModalState = {
  paymentOpen: boolean;
  voidPaymentId: string | null;
  createInvoiceOpen: boolean;
  refundInvoiceId: string | null;
  cancelDepositOpen: boolean;
  creditNoteOpen: boolean;
};

export const financeModalInitialState: FinanceModalState = {
  paymentOpen: false,
  voidPaymentId: null,
  createInvoiceOpen: false,
  refundInvoiceId: null,
  cancelDepositOpen: false,
  creditNoteOpen: false,
};

export type FinanceModalAction =
  | { type: "openPayment" }
  | { type: "closePayment" }
  | { type: "openVoidPayment"; paymentId: string }
  | { type: "closeVoidPayment" }
  | { type: "openCreateInvoice" }
  | { type: "closeCreateInvoice" }
  | { type: "openRefund"; invoiceId: string }
  | { type: "closeRefund" }
  | { type: "openCancelDeposit" }
  | { type: "closeCancelDeposit" }
  | { type: "openCreditNote" }
  | { type: "closeCreditNote" };

export function financeModalReducer(
  state: FinanceModalState,
  action: FinanceModalAction,
): FinanceModalState {
  switch (action.type) {
    case "openPayment":
      return { ...state, paymentOpen: true };
    case "closePayment":
      return { ...state, paymentOpen: false };
    case "openVoidPayment":
      return { ...state, voidPaymentId: action.paymentId };
    case "closeVoidPayment":
      return { ...state, voidPaymentId: null };
    case "openCreateInvoice":
      return { ...state, createInvoiceOpen: true };
    case "closeCreateInvoice":
      return { ...state, createInvoiceOpen: false };
    case "openRefund":
      return { ...state, refundInvoiceId: action.invoiceId };
    case "closeRefund":
      return { ...state, refundInvoiceId: null };
    case "openCancelDeposit":
      return { ...state, cancelDepositOpen: true };
    case "closeCancelDeposit":
      return { ...state, cancelDepositOpen: false };
    case "openCreditNote":
      return { ...state, creditNoteOpen: true };
    case "closeCreditNote":
      return { ...state, creditNoteOpen: false };
  }
}

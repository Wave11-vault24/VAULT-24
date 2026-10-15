(() => {
  "use strict";
  const currentUser = sessionStorage.getItem("vault24User");
  if (!currentUser) { window.location.replace("login.html"); return; }


  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      sessionStorage.removeItem("vault24User");
      sessionStorage.removeItem("vault24LoginPasswordHash");
      window.location.replace("login.html?reason=timeout");
    }, IDLE_TIMEOUT_MS);
  };
  ["click", "keydown", "mousemove", "touchstart"].forEach(type => document.addEventListener(type, resetIdleTimer, { passive: true }));
  resetIdleTimer();

  const state = {
    user: (sessionStorage.getItem("vault24User") || "Jane Mwangi").includes("@") ? (sessionStorage.getItem("vault24User").split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase())) : (sessionStorage.getItem("vault24User") || "Jane Mwangi"),
    email: "jane@example.com",
    phone: "+260 97 000 4821",
    visibleBalances: false,
    pendingSecureAction: null,
    passwordPromptAttempts: 0,
    balance: 2450,
    currentReceipt: null,
    pendingTransfer: null,
    pendingPaymentOtpAction: null,
    toastTimer: null,
    transactions: [
      { date: "2025-06-12 10:24 AM", description: "Money received from John D.", type: "Credit", amount: 500, recipient: "John D.", note: "Money received", reference: "V24-250612-001" },
      { date: "2025-06-11 02:36 PM", description: "Transfer to Savings Account", type: "Debit", amount: 300, recipient: "Savings Account", note: "Savings transfer", reference: "V24-250611-002" },
      { date: "2025-06-10 09:12 AM", description: "ATM Withdrawal", type: "Debit", amount: 100, recipient: "ATM Withdrawal", note: "Cash withdrawal", reference: "V24-250610-003" },
      { date: "2025-06-08 04:20 PM", description: "Salary Deposit", type: "Credit", amount: 1200, recipient: "Employer", note: "Salary", reference: "V24-250608-004" },
      { date: "2025-06-06 11:17 AM", description: "Electricity Bill Payment", type: "Debit", amount: 75, recipient: "Electricity provider", note: "Utility bill", reference: "V24-250606-005" },
      { date: "2025-06-04 03:45 PM", description: "Transfer to Mary S.", type: "Debit", amount: 250, recipient: "Mary S.", note: "Personal transfer", reference: "V24-250604-006" }
    ]
  };

  const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const money = amount => "K " + Math.abs(amount).toLocaleString("en-ZM", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  function maskProfileValue(value) {
    const clean = String(value || "").trim();
    if (!clean) return "Not provided";
    if (clean.length <= 3) return clean[0] + "•".repeat(Math.max(1, clean.length - 2)) + clean.slice(-1);
    return clean.slice(0, 2) + "•".repeat(Math.min(10, clean.length - 3)) + clean.slice(-1);
  }

  function renderMaskedProfile() {
    $("#maskedProfileName").textContent = maskProfileValue(state.user);
    $("#maskedProfileEmail").textContent = maskProfileValue(state.email);
    $("#maskedProfilePhone").textContent = maskProfileValue(state.phone);
    $("#passwordOtpPhone").value = maskProfileValue(state.phone);
  }

  const transactionPasswordKey = `vault24TransactionPin:${sessionStorage.getItem("vault24User") || "account"}`;
  let pendingPasswordAction = null;

  async function passwordDigest(password) {
    const bytes = new TextEncoder().encode(password);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function hasTransactionPassword() {
    return Boolean(localStorage.getItem(transactionPasswordKey));
  }

  function requestTransactionPassword(action, title, message) {
    if (!hasTransactionPassword()) {
      state.visibleBalances = false;
      renderBalances();
      $("#transactionPasswordPromptText").textContent = "Set a separate 4–6 digit transaction PIN in Profile before viewing balances, authorizing transfers, or exporting a slip.";
      $("#transactionPasswordHeading").textContent = "Transaction PIN required";
      $("#transactionPasswordPromptMessage").textContent = "Open Profile → Transaction PIN to set it up.";
      $("#transactionPasswordPromptInput").classList.add("hidden");
      $("#transactionPasswordPromptForm button[type=submit]").classList.add("hidden");
      $("#transactionPasswordBackdrop").classList.remove("hidden");
      pendingPasswordAction = null;
      return;
    }
    pendingPasswordAction = action;
    $("#transactionPasswordHeading").textContent = title;
    $("#transactionPasswordPromptText").textContent = message;
    $("#transactionPasswordPromptMessage").textContent = "";
    $("#transactionPasswordPromptInput").classList.remove("hidden");
    $("#transactionPasswordPromptForm button[type=submit]").classList.remove("hidden");
    $("#transactionPasswordPromptInput").value = "";
    $("#transactionPasswordBackdrop").classList.remove("hidden");
    $("#transactionPasswordPromptInput").focus();
  }

  function closeTransactionPasswordPrompt() {
    $("#transactionPasswordBackdrop").classList.add("hidden");
    $("#transactionPasswordPromptInput").value = "";
    $("#transactionPasswordPromptInput").classList.remove("hidden");
    $("#transactionPasswordPromptForm button[type=submit]").classList.remove("hidden");
    $("#transactionPasswordPromptMessage").textContent = "";
    pendingPasswordAction = null;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  function getFilteredTransactions() {
    const query = $("#searchInput").value.trim().toLowerCase();
    if (!query) return state.transactions;
    return state.transactions.filter(transaction =>
      [transaction.date, transaction.description, transaction.type, transaction.recipient, transaction.reference]
        .some(value => value.toLowerCase().includes(query))
    );
  }

  function displayedAmount(transaction) {
    if (!state.visibleBalances) return "••••";
    return (transaction.type === "Credit" ? "+" : "−") + money(transaction.amount);
  }

  function transactionRow(transaction, index) {
    const iconClass = transaction.type === "Credit" ? "credit" : "debit";
    const icon = transaction.type === "Credit" ? "↓" : "↑";
    return `<tr tabindex="0" role="button" data-transaction-index="${index}" aria-label="Open receipt for ${escapeHTML(transaction.description)}">
      <td>${escapeHTML(transaction.date)}</td>
      <td>${escapeHTML(transaction.description)}</td>
      <td><span class="type-cell"><span class="type-icon ${iconClass}">${icon}</span>${escapeHTML(transaction.type)}</span></td>
      <td>${displayedAmount(transaction)}</td>
      <td>${state.visibleBalances ? money(state.balance) : "••••"}</td>
      <td class="row-arrow">›</td>
    </tr>`;
  }

  function renderTransactions() {
    const transactions = getFilteredTransactions();
    const recent = transactions.slice(0, 6);
    $("#recentTransactions").innerHTML = recent.map(transactionRow).join("");
    $("#allTransactions").innerHTML = transactions.map(transactionRow).join("");
    $("#recentEmpty").classList.toggle("hidden", recent.length !== 0);
    $("#historyEmpty").classList.toggle("hidden", transactions.length !== 0);
    $("#transactionCount").textContent = String(state.transactions.length).padStart(4, "0");
  }

  function renderBalances() {
    $$("[data-balance-value]").forEach(element => {
      element.textContent = state.visibleBalances ? money(state.balance) : "••••••";
    });
    $$("[data-toggle-balance]").forEach(button => {
      button.textContent = state.visibleBalances ? "◉" : "◉̸";
      button.setAttribute("aria-label", state.visibleBalances ? "Hide balance" : "Show balance");
      button.setAttribute("title", state.visibleBalances ? "Hide balance" : "Show balance");
    });
    renderTransactions();
  }

  function navigate(page) {
    $$(".page").forEach(section => section.classList.toggle("active", section.id === `page-${page}`));
    $$(".nav-item[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === page));
    closeSidebar();
    if (page === "history") renderTransactions();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSidebar() {
    $("#sidebar").classList.add("open");
    $("#mobileMenu").setAttribute("aria-expanded", "true");
    $("#mobileMenu").setAttribute("aria-label", "Close navigation");
    $("#mobileMenu").textContent = "✕";
  }

  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#mobileMenu").setAttribute("aria-expanded", "false");
    $("#mobileMenu").setAttribute("aria-label", "Open navigation");
    $("#mobileMenu").textContent = "☰";
  }

  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || "").join("");
  }

  function updateUser() {
    $("#topUserName").textContent = `Hello, ${state.user}`;
    $("#welcomeHeading").textContent = `Welcome back, ${state.user.split(" ")[0]}!`;
    $("#avatarInitials").textContent = initials(state.user);
  }

  function openReceipt(transaction) {
    state.currentReceipt = transaction;
    $("#receiptAmount").textContent = state.visibleBalances
      ? (transaction.type === "Credit" ? "+" : "−") + money(transaction.amount)
      : "••••••";
    $("#receiptType").textContent = `${transaction.type} · ${transaction.description}`;
    const details = [
      ["Transaction reference", transaction.reference],
      ["Date and time", transaction.date],
      ["Transaction type", transaction.type],
      ["Description", transaction.description],
      ["Account holder", state.user],
      ["Recipient / source", transaction.recipient],
      ["Amount", state.visibleBalances ? money(transaction.amount) : "Hidden for privacy"],
      ["Status", "Recorded in this interface"],
      ["Note", transaction.note]
    ];
    $("#receiptDetails").innerHTML = details.map(([label, value]) =>
      `<div class="receipt-row"><span>${escapeHTML(label)}</span><span>${escapeHTML(value)}</span></div>`
    ).join("");
    $("#receiptMessage").textContent = "";
    navigate("receipt");
  }

  function receiptText(transaction) {
    return [
      "VAULT24 — TRANSACTION RECEIPT",
      "ACCOUNT ACTIVITY RECEIPT",
      "====================================",
      `Reference: ${transaction.reference}`,
      `Date and time: ${transaction.date}`,
      `Type: ${transaction.type}`,
      `Description: ${transaction.description}`,
      `Account holder: ${state.user}`,
      `Recipient / source: ${transaction.recipient}`,
      `Amount: ${money(transaction.amount)}`,
      "Status: Recorded in this interface",
      `Note: ${transaction.note}`,
      "",
      "This receipt is not confirmation from a bank or payment provider."
    ].join("\n");
  }

  function performDownloadReceipt() {
    const transaction = state.currentReceipt;
    if (!transaction) return;
    const blob = new Blob([receiptText(transaction)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `VAULT24-${transaction.reference}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("#receiptMessage").textContent = "Your transaction slip has been prepared.";
  }

  function performPrintReceipt() {
    const transaction = state.currentReceipt;
    if (!transaction) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      $("#receiptMessage").textContent = "The browser blocked the print window. Use Download Slip instead.";
      return;
    }
    const rows = [
      ["Reference", transaction.reference], ["Date and time", transaction.date],
      ["Type", transaction.type], ["Description", transaction.description],
      ["Account holder", state.user], ["Recipient / source", transaction.recipient],
      ["Amount", money(transaction.amount)], ["Status", "Recorded in this interface"], ["Note", transaction.note]
    ];
    printWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VAULT24 Receipt</title>
      <style>body{font:15px Arial;max-width:650px;margin:35px auto;padding:22px;color:#15325c}h1{color:#1769e8}.row{display:flex;justify-content:space-between;gap:15px;padding:12px 0;border-bottom:1px dashed #ccd8e9}.muted{color:#647b9b;font-size:12px}</style>
      </head><body><h1>VAULT24</h1><h2>Transaction Receipt</h2>
      ${rows.map(([label, value]) => `<div class="row"><span>${escapeHTML(label)}</span><b>${escapeHTML(value)}</b></div>`).join("")}
      <p class="muted">This receipt is not confirmation from a bank or payment provider.</p></body></html>`);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  }

  function closeTransferModal() {
    $("#modalBackdrop").classList.add("hidden");
    state.pendingTransfer = null;
  }

  function completeTransfer() {
    const transfer = state.pendingTransfer;
    if (!transfer) return;
    state.balance -= transfer.amount;
    const now = new Date();
    const date = now.toLocaleDateString() + " " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const reference = `V24-${Date.now().toString().slice(-8)}`;
    state.transactions.unshift({
      date, description: `${transfer.methodLabel || "Transfer"} to ${transfer.recipient}`, type: "Debit",
      amount: transfer.amount, recipient: transfer.recipient,
      note: [`From account: ${maskProfileValue(transfer.sourceAccount)}`, transfer.destination, transfer.note || "Customer transfer"].filter(Boolean).join(" · "), reference
    });
    closeTransferModal();
    $("#transferForm").reset();
    $("#transferMessage").textContent = "Transfer details recorded in this interface. No external payment provider confirmed the transfer.";
    renderBalances();
    showToast("Transfer record created.");
  }

  $$(".nav-item[data-page]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.page)));
  $$("[data-go-page]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.goPage)));
  document.addEventListener("click", event => {
    const row = event.target.closest("[data-transaction-index]");
    if (!row || !$("#page-dashboard").classList.contains("active") && !$("#page-history").classList.contains("active")) return;
    const visibleRows = getFilteredTransactions();
    const transaction = visibleRows[Number(row.dataset.transactionIndex)];
    if (transaction) openReceipt(transaction);
  });

  $("#mobileMenu").addEventListener("click", () => {
    $("#sidebar").classList.contains("open") ? closeSidebar() : openSidebar();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeSidebar();
      closeTransferModal();
      closeTransactionPasswordPrompt();
      closePaymentOtpPrompt();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#searchInput").focus();
    }
  });
  document.addEventListener("click", event => {
    if (window.innerWidth <= 760 && $("#sidebar").classList.contains("open") &&
        !$("#sidebar").contains(event.target) && !$("#mobileMenu").contains(event.target)) closeSidebar();
  });

  $$('[data-toggle-balance]').forEach(button => button.addEventListener("click", () => {
    if (state.visibleBalances) {
      state.visibleBalances = false;
      renderBalances();
      return;
    }
    requestTransactionPassword(() => {
      state.visibleBalances = true;
      renderBalances();
    }, "View account balance", "Enter your transaction PIN to reveal your account balances.");
  }));
  $("#searchInput").addEventListener("input", renderTransactions);
  $("#notificationsButton").addEventListener("click", () => showToast("You're all caught up."));
  $("#userMenuButton").addEventListener("click", () => navigate("profile"));

  $("#profileForm").addEventListener("submit", event => {
    event.preventDefault();
    const email = $("#profileEmail").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      $("#profileEmail").setCustomValidity("Enter a valid email address containing @ and a domain.");
      $("#profileEmail").reportValidity();
      $("#profileEmail").setCustomValidity("");
      return;
    }
    const name = $("#profileName").value.trim();
    const phone = $("#profilePhone").value.trim();
    if (!name || !phone) {
      $("#profileMessage").textContent = "Enter your full name, valid email address, and phone number to update your profile.";
      return;
    }
    state.user = name;
    state.email = email;
    state.phone = phone;
    updateUser();
    renderMaskedProfile();
    $("#profileForm").reset();
    $("#profileMessage").textContent = "Profile details updated. Full details remain hidden in the profile summary.";
    showToast("Profile updated.");
  });

  $("#passwordOtpRequestForm").addEventListener("submit", event => {
    event.preventDefault();
    $("#changePasswordForm").classList.remove("hidden");
    $("#passwordOtpMessage").textContent = "Verification delivery is not connected. Use a secure backend to change account passwords.";
    $("#passwordOtpCode").focus();
  });

  $("#passwordOtpCode").addEventListener("input", event => {
    event.target.value = event.target.value.replace(/\\D/g, "").slice(0, 6);
  });

  $("#changePasswordForm").addEventListener("submit", event => {
    event.preventDefault();
    const otp = $("#passwordOtpCode").value.trim();
    const newPassword = $("#newPassword").value;
    const confirmPassword = $("#confirmNewPassword").value;
    const message = $("#changePasswordMessage");
    if (otp !== "654321") {
      message.textContent = "Verification failed. Password changes require server-side verification.";
      return;
    }
    if (newPassword.length < 8) {
      message.textContent = "Use a password with at least 8 characters.";
      return;
    }
    if (newPassword !== confirmPassword) {
      message.textContent = "The new passwords do not match.";
      return;
    }
    message.textContent = "Password changes are not enabled until server-side verification is connected.";
    $("#passwordOtpCode").value = "";
    $("#newPassword").value = "";
    $("#confirmNewPassword").value = "";
    showToast("Password change is not enabled.");
  });

  ["#currentTransactionPassword", "#newTransactionPassword", "#confirmTransactionPassword", "#transactionPasswordPromptInput"].forEach(selector => {
    $(selector).addEventListener("input", event => { event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6); });
  });

  $("#transactionPasswordForm").addEventListener("submit", async event => {
    event.preventDefault();
    const current = $("#currentTransactionPassword").value;
    const next = $("#newTransactionPassword").value;
    const confirm = $("#confirmTransactionPassword").value;
    const message = $("#transactionPasswordMessage");
    if (hasTransactionPassword()) {
      if (!current || await passwordDigest(current) !== localStorage.getItem(transactionPasswordKey)) {
        message.textContent = "The current transaction PIN is incorrect.";
        return;
      }
    }
    if (!/^\d{4,6}$/.test(next)) {
      message.textContent = "Your transaction PIN must contain 4 to 6 digits.";
      return;
    }
    if (next !== confirm) {
      message.textContent = "The transaction PINs do not match.";
      return;
    }
    const loginPasswordHash = sessionStorage.getItem("vault24LoginPasswordHash");
    if (loginPasswordHash && await passwordDigest(next) === loginPasswordHash) {
      message.textContent = "Choose a 4–6 digit PIN. Your login password remains separate.";
      return;
    }
    localStorage.setItem(transactionPasswordKey, await passwordDigest(next));
    message.textContent = "Transaction PIN saved. Use it for balances, transfers, and transaction slips. Your login password remains separate.";
    $("#currentTransactionPassword").value = "";
    $("#newTransactionPassword").value = "";
    $("#confirmTransactionPassword").value = "";
    $("#currentTransactionPasswordLabel").classList.remove("hidden");
    showToast("Transaction PIN updated.");
  });

  $("#transactionPasswordPromptForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!pendingPasswordAction) return;
    const entered = $("#transactionPasswordPromptInput").value.trim();
    if (!/^\d{4,6}$/.test(entered)) {
      $("#transactionPasswordPromptMessage").textContent = "Enter your 4–6 digit transaction PIN.";
      return;
    }
    const stored = localStorage.getItem(transactionPasswordKey);
    if (!stored || await passwordDigest(entered) !== stored) {
      state.passwordPromptAttempts += 1;
      $("#transactionPasswordPromptMessage").textContent = state.passwordPromptAttempts >= 5
        ? "Too many attempts. Close this prompt and try again later."
        : `Incorrect transaction PIN. ${5 - state.passwordPromptAttempts} attempt(s) remaining.`;
      if (state.passwordPromptAttempts >= 5) {
        $("#transactionPasswordPromptForm button[type=submit]").disabled = true;
      }
      return;
    }
    state.passwordPromptAttempts = 0;
    const action = pendingPasswordAction;
    closeTransactionPasswordPrompt();
    if (action === completeTransfer) {
      state.pendingPaymentOtpAction = action;
      const registeredPhone = state.phone || "your registered phone number";
      $("#paymentOtpDestination").textContent = `Enter the 6-digit OTP sent to your registered phone (${registeredPhone}) to authorize this payment.`;
      $("#paymentOtpMessage").textContent = "SMS delivery is not connected in this frontend project. The OTP field is a user-interface step only until a secure backend and SMS gateway are configured.";
      $("#paymentOtpCode").value = "";
      $("#paymentOtpBackdrop").classList.remove("hidden");
      $("#paymentOtpCode").focus();
      return;
    }
    action();
  });
  $("#cancelTransactionPasswordPrompt").addEventListener("click", closeTransactionPasswordPrompt);

  function closePaymentOtpPrompt() {
    const backdrop = $("#paymentOtpBackdrop");
    if (backdrop) backdrop.classList.add("hidden");
    const code = $("#paymentOtpCode");
    if (code) code.value = "";
    const message = $("#paymentOtpMessage");
    if (message) message.textContent = "";
    state.pendingPaymentOtpAction = null;
  }

  $("#cancelPaymentOtp").addEventListener("click", () => {
    closePaymentOtpPrompt();
    closeTransferModal();
    $("#transferMessage").textContent = "Payment authorization cancelled.";
  });

  $("#paymentOtpForm").addEventListener("submit", event => {
    event.preventDefault();
    const code = $("#paymentOtpCode").value.trim();
    if (!/^\d{6}$/.test(code)) {
      $("#paymentOtpMessage").textContent = "Enter a 6-digit verification code.";
      return;
    }
    const action = state.pendingPaymentOtpAction;
    closePaymentOtpPrompt();
    if (typeof action === "function") action();
  });

  const paymentMethod = $("#paymentMethod");
  const bankFields = $("#bankFields");
  const mobileFields = $("#mobileFields");
  const recipientBank = $("#recipientBank");
  const recipientAccount = $("#recipientAccount");
  const recipientMobile = $("#recipientMobile");

  function updatePaymentFields() {
    const isBank = paymentMethod.value === "bank";
    bankFields.classList.toggle("hidden", !isBank);
    mobileFields.classList.toggle("hidden", isBank);
    recipientBank.required = isBank;
    recipientAccount.required = isBank;
    recipientMobile.required = !isBank;
    recipientBank.disabled = !isBank;
    recipientAccount.disabled = !isBank;
    recipientMobile.disabled = isBank;
    recipientMobile.placeholder = paymentMethod.value === "mtn" ? "MTN number, e.g. 0971234567" : "Airtel number, e.g. 0971234567";
    $("#mobileNumberLabel").firstChild.textContent = paymentMethod.value === "mtn" ? "MTN Mobile Money number" : "Airtel Money number";
    $("#transferMessage").textContent = "";
  }
  paymentMethod.addEventListener("change", updatePaymentFields);
  updatePaymentFields();
  $$('[data-quick-transfer]').forEach(button => button.addEventListener("click", () => {
    paymentMethod.value = button.dataset.quickTransfer;
    updatePaymentFields();
    navigate("transfer");
    $("recipientName").focus();
  }));

  $("#transferForm").addEventListener("submit", event => {
    event.preventDefault();
    const recipient = $("#recipientName").value.trim();
    const sourceAccount = $("#sourceAccount").value.trim();
    const amount = Number($("#transferAmount").value);
    if (!/^[0-9]{6,34}$/.test(sourceAccount)) {
      $("#transferMessage").textContent = "Enter your valid VAULT24 account number (6–34 digits) before continuing.";
      $("#sourceAccount").focus();
      return;
    }
    const note = $("#transferNote").value.trim();
    const method = paymentMethod.value;
    let destination = "";
    let methodLabel = "Bank-to-bank transfer";
    if (method === "bank") {
      const bank = recipientBank.value.trim();
      const account = recipientAccount.value.trim();
      if (!bank || !/^[0-9]{6,34}$/.test(account)) {
        $("#transferMessage").textContent = "Enter a bank name and a valid account number (6–34 digits).";
        return;
      }
      destination = `Bank: ${bank}; Account: ${account}`;
    } else {
      const mobile = recipientMobile.value.trim();
      if (!/^\+?[0-9][0-9\s-]{7,18}$/.test(mobile)) {
        $("#transferMessage").textContent = "Enter a valid mobile-money phone number.";
        return;
      }
      methodLabel = method === "mtn" ? "MTN Mobile Money" : "Airtel Money";
      destination = `Mobile number: ${mobile}`;
    }
    if (!recipient || !Number.isFinite(amount) || amount <= 0 || amount > state.balance) {
      $("#transferMessage").textContent = `Enter a valid recipient and an amount no greater than ${money(state.balance)}.`;
      return;
    }
    state.pendingTransfer = { recipient, amount, note, method, methodLabel, destination, sourceAccount };
    if ($("#confirmTransfersSetting").checked) {
      $("#confirmText").textContent = `Review payment: ${methodLabel} of ${money(amount)} from account ${maskProfileValue(sourceAccount)} to ${recipient}. ${destination}. Select Pay Now to enter your transaction PIN and then your OTP. This interface does not submit payments to a bank or mobile-money provider.`;
      $("#modalBackdrop").classList.remove("hidden");
      $("#confirmTransfer").focus();
    } else {
      requestTransactionPassword(completeTransfer, "Authorize transfer", "Enter your transaction PIN to proceed with this payment. You will then be asked for a 6-digit OTP.");
    }
  });
  $("#cancelTransfer").addEventListener("click", closeTransferModal);
  $("#confirmTransfer").addEventListener("click", () => requestTransactionPassword(completeTransfer, "Authorize transfer", "Enter your transaction PIN to proceed with this payment. You will then be asked for a 6-digit OTP."));
  $("#modalBackdrop").addEventListener("click", event => {
    if (event.target === $("#modalBackdrop")) closeTransferModal();
  });

  $("#hideBalancesSetting").addEventListener("change", event => {
    if (event.target.checked) {
      state.visibleBalances = false;
      renderBalances();
    }
  });
  $("#downloadReceipt").addEventListener("click", () => requestTransactionPassword(performDownloadReceipt, "Authorize slip download", "Enter your transaction PIN to download this transaction slip."));
  $("#printReceipt").addEventListener("click", () => requestTransactionPassword(performPrintReceipt, "Authorize printing", "Enter your transaction PIN to print or save this transaction slip."));
  $("#logoutButton").addEventListener("click", () => {
    sessionStorage.removeItem("vault24User");
    sessionStorage.removeItem("vault24LoginPasswordHash");
    window.location.replace("login.html");
  });

  if (hasTransactionPassword()) $("#currentTransactionPasswordLabel").classList.remove("hidden");
  updateUser();
  renderBalances();
})();

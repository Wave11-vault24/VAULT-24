(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const loginStep = $("loginStep");
  const otpStep = $("otpStep");
  const loginForm = $("loginForm");
  const otpForm = $("otpForm");
  let pendingUser = "";
  let pendingAccountNumber = "";
  let otpAttempts = 0;
  let loginLockedUntil = 0;

  $("togglePassword").addEventListener("click", () => {
    const input = $("password");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("togglePassword").textContent = showing ? "Show" : "Hide";
    $("togglePassword").setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    $("loginError").textContent = "";
    const user = $("customerId").value.trim();
    const accountNumber = $("accountNumber").value.trim();
    const password = $("password").value;
    if (Date.now() < loginLockedUntil) {
      $("loginError").textContent = "Sign-in is temporarily locked. Please wait before trying again.";
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(user)) {
      $("loginError").textContent = "Enter a valid email address containing @ and a domain.";
      return;
    }
    if (!/^\d{6,34}$/.test(accountNumber)) {
      $("loginError").textContent = "Enter the registered account number using 6 to 34 digits.";
      $("accountNumber").focus();
      return;
    }
    if (password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      $("loginError").textContent = "Use at least 10 characters including uppercase, lowercase, a number and a symbol.";
      return;
    }
    pendingUser = user;
    pendingAccountNumber = accountNumber;
    const passwordDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
    sessionStorage.setItem("vault24LoginPasswordHash", [...new Uint8Array(passwordDigest)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
    loginStep.classList.add("hidden");
    otpStep.classList.remove("hidden");
    $("otpCode").focus();
  });

  otpForm.addEventListener("submit", event => {
    event.preventDefault();
    $("otpError").textContent = "";
    const code = $("otpCode").value.trim();
    if (Date.now() < loginLockedUntil) {
      $("otpError").textContent = "Verification is temporarily locked. Please wait before trying again.";
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      $("otpError").textContent = "Enter all 6 digits.";
      return;
    }
    otpAttempts = 0;
    sessionStorage.setItem("vault24User", pendingUser);
    sessionStorage.setItem("vault24AccountNumber", pendingAccountNumber);
    window.location.href = "dashboard.html";
  });

  $("backToLogin").addEventListener("click", () => {
    otpStep.classList.add("hidden");
    loginStep.classList.remove("hidden");
    $("otpError").textContent = "";
    $("password").focus();
  });

  $("resendOtp").addEventListener("click", () => {
    $("otpError").textContent = "Verification delivery is not connected in this interface.";
  });

  $("forgotPassword").addEventListener("click", event => {
    event.preventDefault();
    $("loginError").textContent = "Password recovery will be connected when the backend is built.";
  });

  $("accountNumber").addEventListener("input", event => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 34);
  });

  $("otpCode").addEventListener("input", event => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
  });
})();
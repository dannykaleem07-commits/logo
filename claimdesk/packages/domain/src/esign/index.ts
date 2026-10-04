// esign module — BLUEPRINT §3.8 in-house e-signature: OTP, certificate, signature-date sanity. Named exports only.
export {
  generateOtp,
  verifyOtp,
  normaliseContact,
  otpBase,
  OTP_DEFAULT_TTL_MINUTES,
  type GenerateOtpInput,
  type GeneratedOtp,
  type VerifyOtpInput,
  type VerifyOtpResult,
  type OtpFailureReason
} from './otp.js';
export { buildCertificate, certificateIdFor, DEFAULT_ISSUER, type BuildCertificateInput, type Certificate, type CertificateJson } from './certificate.js';
export { signatureDateChecks, reExecutionLine, isAgreementTemplate } from './dates.js';

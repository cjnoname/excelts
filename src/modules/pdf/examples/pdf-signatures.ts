/**
 * Example: PDF Digital Signatures
 *
 * Covers:
 *   1. Sign a new PDF with PdfDocumentBuilder.sign()
 *   2. Sign an existing PDF with PdfEditor.sign()
 *   3. Verify a signature with Pdf.verifySignature()
 *   4. Tamper detection — modified PDF fails verification
 *
 * Run: pnpm example --filter pdf-signatures
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pdf } from "../index";
import { generateSelfSignedCertificate } from "./utils/self-signed-certificate";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// A signing identity is an *input* to this example, not something the library
// produces. This generates a throwaway self-signed one so the example runs
// unattended; in production the certificate and key come from a CA, a keystore
// or an HSM. See `./utils/self-signed-certificate.ts` for the openssl equivalent.
const { certificate, privateKey } = await generateSelfSignedCertificate("Example Signer");

// =============================================================================
// 1. Sign a New PDF (PdfDocumentBuilder)
// =============================================================================

{
  console.log("1. Sign a new PDF with PdfDocumentBuilder:");

  const doc = new Pdf.Builder();
  doc.setMetadata({ title: "Signed Agreement", author: "documonster" });

  const page = doc.addPage();
  page.drawText("Service Agreement", { x: 72, y: 750, fontSize: 24, bold: true });
  page.drawText("This document is digitally signed to ensure authenticity.", {
    x: 72,
    y: 720,
    fontSize: 12
  });
  page.drawText("Any modification after signing will invalidate the signature.", {
    x: 72,
    y: 700,
    fontSize: 11,
    color: { r: 0.4, g: 0.4, b: 0.4 }
  });

  // One method call — certificate, key, and metadata
  doc.sign({
    certificate,
    privateKey,
    name: "Alice Johnson",
    reason: "Contract approval",
    location: "San Francisco, CA"
  });

  const signedPdf = await doc.build();
  fs.writeFileSync(path.join(outDir, "01-builder-signed.pdf"), signedPdf);
  console.log(`   Output: 01-builder-signed.pdf (${signedPdf.length} bytes)`);

  // Verify it
  const verification = await verifyFromPdf(signedPdf);
  console.log(`   Valid: ${verification.valid}`);
  console.log(`   Covers whole file: ${verification.coversWholeFile}`);
}

// =============================================================================
// 2. Sign an Existing PDF (PdfEditor)
// =============================================================================

{
  console.log("\n2. Sign an existing PDF with PdfEditor:");

  // First, create an unsigned PDF
  const doc = new Pdf.Builder();
  const page = doc.addPage();
  page.drawText("Invoice #12345", { x: 72, y: 750, fontSize: 20, bold: true });
  page.drawText("Amount: $1,500.00", { x: 72, y: 720, fontSize: 14 });
  page.drawText("Due: 2026-05-01", { x: 72, y: 700, fontSize: 12 });
  const unsignedPdf = await doc.build();
  fs.writeFileSync(path.join(outDir, "02-unsigned.pdf"), unsignedPdf);
  console.log(`   Unsigned: 02-unsigned.pdf (${unsignedPdf.length} bytes)`);

  // Load and sign — one method call
  const editor = Pdf.Editor.load(unsignedPdf);
  const signedPdf = await editor.sign({
    certificate,
    privateKey,
    name: "Bob Smith",
    reason: "Invoice approval"
  });
  fs.writeFileSync(path.join(outDir, "02-editor-signed.pdf"), signedPdf);
  console.log(`   Signed:   02-editor-signed.pdf (${signedPdf.length} bytes)`);

  const verification = await verifyFromPdf(signedPdf);
  console.log(`   Valid: ${verification.valid}`);
  console.log(`   Covers whole file: ${verification.coversWholeFile}`);
}

// =============================================================================
// 3. Tamper Detection
// =============================================================================

{
  console.log("\n3. Tamper detection:");

  const doc = new Pdf.Builder();
  doc.addPage().drawText("Tamper test", { x: 72, y: 750, fontSize: 16 });
  doc.sign({ certificate, privateKey, name: "Security Test" });
  const signedPdf = await doc.build();

  // Verify original — should pass
  const original = await verifyFromPdf(signedPdf);
  console.log(`   Original: valid=${original.valid}`);

  // Tamper with a byte and verify — should fail
  const tampered = new Uint8Array(signedPdf);
  tampered[50] = tampered[50] ^ 0xff;
  const tamperedResult = await verifyFromPdf(tampered);
  console.log(`   Tampered: valid=${tamperedResult.valid}`);
  console.log(`   Reason:   ${tamperedResult.reason}`);
}

// =============================================================================
// 4. Read Signed PDF — Confirm Signature Presence
// =============================================================================

{
  console.log("\n4. Read signed PDF to confirm signature field:");

  const doc = new Pdf.Builder();
  doc.addPage().drawText("Document with signature field", { x: 72, y: 750, fontSize: 14 });
  doc.sign({ certificate, privateKey, name: "Reader Test" });
  const signedPdf = await doc.build();

  const result = await Pdf.read(signedPdf);
  const sigField = result.formFields.find(f => f.type === "signature");
  console.log(`   Form fields: ${result.formFields.length}`);
  console.log(`   Signature field found: ${sigField !== undefined}`);
  if (sigField) {
    console.log(`   Field name: "${sigField.name}"`);
  }
}

console.log(`\nAll examples written to: ${outDir}`);

// =============================================================================
// Helper: Extract and verify signature from PDF bytes
// =============================================================================

async function verifyFromPdf(pdf: Uint8Array) {
  const text = new TextDecoder().decode(pdf);

  const contentsMatch = text.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
  if (!contentsMatch) {
    return { valid: false, coversWholeFile: false, digestAlgorithm: "", reason: "No /Contents" };
  }

  const brMatch = text.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  if (!brMatch) {
    return { valid: false, coversWholeFile: false, digestAlgorithm: "", reason: "No /ByteRange" };
  }

  return Pdf.verifySignature(pdf, contentsMatch[1], [
    parseInt(brMatch[1]),
    parseInt(brMatch[2]),
    parseInt(brMatch[3]),
    parseInt(brMatch[4])
  ]);
}

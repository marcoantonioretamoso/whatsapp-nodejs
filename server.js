import express from "express";
import cors from "cors";
// import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { makeWASocket, useMultiFileAuthState } from "@whiskeysockets/baileys";

import qrcode from "qrcode";

const app = express();
app.use(cors());
app.use(express.json());

let currentQR = null;
let isConnected = false;

// Función principal de WhatsApp
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // 🚫 Desactivamos el QR en consola
  });

  // Escucha actualizaciones de conexión y QR
//   sock.ev.on("connection.update", async (update) => {
//     const { qr, connection, lastDisconnect } = update;

//     if (qr) {
//       console.log("⚡ Nuevo QR generado");
//       currentQR = await qrcode.toDataURL(qr); // Generamos el QR base64
//     }

//     if (connection === "open") {
//       isConnected = true;
//       console.log("✅ WhatsApp conectado correctamente");
//       currentQR = null; // limpiamos el QR
//     }

//     if (connection === "close") {
//       isConnected = false;
//       console.log("❌ Conexión cerrada. Intentando reconectar...");
//       setTimeout(startWhatsApp, 3000);
//     }
//   });
sock.ev.on("connection.update", async (update) => {
  console.log("🔍 Evento connection.update recibido:", update);

  const { qr, connection, lastDisconnect } = update;

  if (qr) {
    console.log("⚡ Nuevo QR generado");
    currentQR = await qrcode.toDataURL(qr);
  }

  if (connection === "open") {
    isConnected = true;
    console.log("✅ WhatsApp conectado correctamente");
    currentQR = null;
  }

  if (connection === "close") {
    isConnected = false;
    console.log("❌ Conexión cerrada. Intentando reconectar...");
    setTimeout(startWhatsApp, 3000);
  }
});


  sock.ev.on("creds.update", saveCreds);
}

// Endpoint para obtener el QR actual
app.get("/qr", async (req, res) => {
  console.log("📲 Solicitud de QR recibida");

  // Esperamos un poco si el QR aún no está listo
  let attempts = 0;
  while (!currentQR && attempts < 10 && !isConnected) {
    await new Promise((r) => setTimeout(r, 500)); // esperamos 0.5 segundos
    attempts++;
  }

  if (currentQR) {
    return res.json({ qr: currentQR });
  } else if (isConnected) {
    return res.json({ message: "Conectado ✅" });
  } else {
    return res.status(404).json({ message: "QR no disponible aún" });
  }
});


// Inicializar servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  startWhatsApp();
});

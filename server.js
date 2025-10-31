import express from "express";
import cors from "cors";
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

let currentQR = null;
let isConnected = false;
let sock = null;
let userInfo = null;

// Función para eliminar la carpeta de sesión
async function clearSession() {
  try {
    const sessionPath = path.join(__dirname, 'session');
    try {
      await fs.access(sessionPath);
      await fs.rm(sessionPath, { recursive: true, force: true });
      console.log('🧹 Sesión eliminada automáticamente');
      return true;
    } catch (error) {
      console.log('📁 No se encontró sesión para eliminar');
      return true;
    }
  } catch (error) {
    console.error('❌ Error eliminando sesión:', error);
    return false;
  }
}

// Función principal de WhatsApp
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    retryRequestDelayMs: 1000,
    maxRetries: 3,
  });

  sock.ev.on("connection.update", async (update) => {
    console.log("🔍 Evento connection.update recibido:", update);

    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log("⚡ Nuevo QR generado");
      currentQR = await qrcode.toDataURL(qr);
    }

    if (connection === "open") {
      isConnected = true;
      currentQR = null;
      userInfo = {
        id: sock.user.id,
        name: sock.user.name || "Usuario",
        phone: sock.user.id.split(':')[0]
      };
      console.log("✅ WhatsApp conectado correctamente");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect.error)?.output?.statusCode;
      const manualLogout = statusCode === 401;
      
      console.log(`🔍 Status code: ${statusCode}, Manual: ${manualLogout}`);

      if (manualLogout) {
        console.log("🧹 Cierre de sesión manual detectado. No se reconectará.");
        isConnected = false;
        userInfo = null;
        currentQR = null;
        return;
      }

      // Reconexión automática para errores no manuales
      console.log("❌ Conexión cerrada inesperadamente. Reconectando en 3 segundos...");
      isConnected = false;
      userInfo = null;
      currentQR = null;
      
      setTimeout(() => {
        console.log("🔄 Intentando reconexión automática...");
        startWhatsApp();
      }, 3000);
    }
  });
  sock.ev.on("creds.update", saveCreds);
}

// Endpoint para obtener el QR actual
app.get("/qr", async (req, res) => {
  console.log("📲 Solicitud de QR recibida ");

  if (currentQR) {
    return res.json({ qr: currentQR, connected: false });
  } else if (isConnected) {
    return res.json({
      connected: true,
      message: "Conectado ✅",
      user: userInfo
    });
  } else {
    return res.status(404).json({
      message: "QR no disponible aún",
      connected: false
    });
  }
});

// Endpoint para verificar el estado de conexión
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    user: userInfo
  });
});

// Reiniciar conexión de WhatsApp manualmente
app.get("/restart", async (req, res) => {
  try {
    console.log("🔄 Reiniciando conexión de WhatsApp...");
    
    // Limpiar estado anterior
    if (sock) {
      sock.ev.removeAllListeners();
      try {
        await sock.end();
      } catch (e) {
        console.log("⚠️ Error al cerrar conexión anterior:", e.message);
      }
      sock = null;
    }
    
    isConnected = false;
    userInfo = null;
    currentQR = null;
    
    // Reiniciar WhatsApp
    await startWhatsApp();
    
    res.json({ 
      success: true, 
      message: "Conexión reiniciada correctamente. Espera unos segundos y verifica el QR en /qr" 
    });
    
  } catch (error) {
    console.error("❌ Error al reiniciar:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Desvincular cuenta - Versión MEJORADA con eliminación automática de sesión
app.get("/disconnect", async (req, res) => {
  try {
    if (sock) {
      // Remover listeners primero para evitar reconexión automática
      sock.ev.removeAllListeners();
      
      try {
        await sock.logout();
        console.log("🔌 Sesión de WhatsApp cerrada manualmente.");
      } catch (logoutError) {
        console.log("⚠️ Error en logout, forzando cierre:", logoutError.message);
        // Forzar cierre si logout falla
        await sock.end();
      }
      
      sock = null;
    }
    
    // ELIMINAR SESIÓN AUTOMÁTICAMENTE
    await clearSession();
    
    isConnected = false;
    userInfo = null;
    currentQR = null;
    
    console.log("✅ Estado limpiado correctamente. Sesión eliminada.");
    res.json({ 
      success: true, 
      message: "Sesión cerrada correctamente. La sesión ha sido eliminada automáticamente.",
      sessionDeleted: true
    });
    
  } catch (error) {
    console.error("❌ Error al desconectar:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== FUNCIONES DE ENVÍO ====================

// 1. Enviar mensaje de texto a un número
app.post("/send-message", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({
      success: false,
      error: "Número y mensaje son requeridos"
    });
  }

  try {
    // Formatear número (eliminar espacios y caracteres especiales)
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });

    console.log(`📤 Mensaje enviado a ${cleanNumber}`);
    res.json({
      success: true,
      message: "Mensaje enviado correctamente",
      to: cleanNumber
    });

  } catch (error) {
    console.error("❌ Error enviando mensaje:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar mensaje: " + error.message
    });
  }
});

// 2. Enviar mensaje a múltiples números (Broadcast)
app.post("/send-broadcast", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { numbers, message } = req.body;

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({
      success: false,
      error: "El campo 'numbers' debe ser un array con al menos un número"
    });
  }

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "El mensaje es requerido"
    });
  }

  try {
    const results = [];

    // Enviar mensajes en secuencia (no en paralelo para evitar sobrecarga)
    for (const number of numbers) {
      try {
        const cleanNumber = number.replace(/\D/g, '');
        const jid = `${cleanNumber}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        results.push({ number: cleanNumber, status: "success" });
        console.log(`📤 Mensaje enviado a ${cleanNumber}`);

        // Pequeña pausa entre mensajes (100ms)
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`❌ Error enviando a ${number}:`, error.message);
        results.push({
          number: number,
          status: "error",
          error: error.message
        });
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    const errorCount = results.filter(r => r.status === "error").length;

    res.json({
      success: true,
      message: `Mensajes enviados: ${successCount} éxitos, ${errorCount} errores`,
      total: numbers.length,
      successCount,
      errorCount,
      details: results
    });

  } catch (error) {
    console.error("❌ Error en broadcast:", error);
    res.status(500).json({
      success: false,
      error: "Error en broadcast: " + error.message
    });
  }
});

// 3. Enviar imagen
app.post("/send-image", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number, imageUrl, caption } = req.body;

  if (!number || !imageUrl) {
    return res.status(400).json({
      success: false,
      error: "Número y URL de imagen son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || "",
      mimetype: 'image/jpeg'
    });

    console.log(`🖼️ Imagen enviada a ${cleanNumber}`);
    res.json({
      success: true,
      message: "Imagen enviada correctamente",
      to: cleanNumber
    });

  } catch (error) {
    console.error("❌ Error enviando imagen:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar imagen: " + error.message
    });
  }
});

// 4. Enviar documento/archivo
app.post("/send-document", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number, documentUrl, fileName, caption } = req.body;

  if (!number || !documentUrl || !fileName) {
    return res.status(400).json({
      success: false,
      error: "Número, URL y nombre de archivo son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      document: { url: documentUrl },
      fileName: fileName,
      caption: caption || "",
      mimetype: 'application/octet-stream'
    });

    console.log(`📎 Documento enviado a ${cleanNumber}`);
    res.json({
      success: true,
      message: "Documento enviado correctamente",
      to: cleanNumber
    });

  } catch (error) {
    console.error("❌ Error enviando documento:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar documento: " + error.message
    });
  }
});

// 5. Enviar audio
app.post("/send-audio", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number, audioUrl } = req.body;

  if (!number || !audioUrl) {
    return res.status(400).json({
      success: false,
      error: "Número y URL de audio son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      audio: { url: audioUrl },
      mimetype: 'audio/mp4',
      ptt: true // Push to talk
    });

    console.log(`🎵 Audio enviado a ${cleanNumber}`);
    res.json({
      success: true,
      message: "Audio enviado correctamente",
      to: cleanNumber
    });

  } catch (error) {
    console.error("❌ Error enviando audio:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar audio: " + error.message
    });
  }
});

// 6. Enviar video
app.post("/send-video", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number, videoUrl, caption } = req.body;

  if (!number || !videoUrl) {
    return res.status(400).json({
      success: false,
      error: "Número y URL de video son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      video: { url: videoUrl },
      caption: caption || "",
      mimetype: 'video/mp4'
    });

    console.log(`🎥 Video enviado a ${cleanNumber}`);
    res.json({
      success: true,
      message: "Video enviado correctamente",
      to: cleanNumber
    });

  } catch (error) {
    console.error("❌ Error enviando video:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar video: " + error.message
    });
  }
});

// 7. Enviar ubicación
app.post("/send-location", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number, latitude, longitude, name } = req.body;

  if (!number || !latitude || !longitude) {
    return res.status(400).json({
      success: false,
      error: "Número, latitud y longitud son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name: name || "Ubicación"
      }
    });

    console.log(`📍 Ubicación enviada a ${cleanNumber}`);
    res.json({
      success: true,
      message: "Ubicación enviada correctamente",
      to: cleanNumber
    });

  } catch (error) {
    console.error("❌ Error enviando ubicación:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar ubicación: " + error.message
    });
  }
});

// 8. Enviar contacto
app.post("/send-contact", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number, contactNumber, contactName } = req.body;

  if (!number || !contactNumber || !contactName) {
    return res.status(400).json({
      success: false,
      error: "Número, contacto y nombre de contacto son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;
    const contactJid = `${contactNumber.replace(/\D/g, '')}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      contacts: {
        contacts: [{
          displayName: contactName,
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL:${contactNumber}\nEND:VCARD`
        }]
      }
    });

    console.log(`👤 Contacto enviado a ${cleanNumber}`);
    res.json({
      success: true,
      message: "Contacto enviado correctamente",
      to: cleanNumber
    });

  } catch (error) {
    console.error("❌ Error enviando contacto:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar contacto: " + error.message
    });
  }
});

// 9. Verificar si un número existe en WhatsApp
app.post("/check-number", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp no está conectado"
    });
  }

  const { number } = req.body;

  if (!number) {
    return res.status(400).json({
      success: false,
      error: "Número es requerido"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    const [result] = await sock.onWhatsApp(jid);

    if (result && result.exists) {
      res.json({
        success: true,
        exists: true,
        number: cleanNumber,
        jid: result.jid
      });
    } else {
      res.json({
        success: true,
        exists: false,
        number: cleanNumber
      });
    }

  } catch (error) {
    console.error("❌ Error verificando número:", error);
    res.status(500).json({
      success: false,
      error: "Error verificando número: " + error.message
    });
  }
});

// Inicializar servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📚 Endpoints disponibles:`);
  console.log(`   GET  /qr           - Obtener QR para vincular`);
  console.log(`   GET  /status       - Verificar estado de conexión`);
  console.log(`   GET  /restart      - Reiniciar conexión y generar nuevo QR`);
  console.log(`   GET  /disconnect   - Desconectar cuenta manualmente (elimina sesión automáticamente)`);
  console.log(`   POST /send-message - Enviar mensaje de texto`);
  console.log(`   POST /send-broadcast - Enviar mensaje a múltiples números`);
  console.log(`   POST /send-image   - Enviar imagen`);
  console.log(`   POST /send-document - Enviar documento/archivo`);
  console.log(`   POST /send-audio   - Enviar audio`);
  console.log(`   POST /send-video   - Enviar video`);
  console.log(`   POST /send-location - Enviar ubicación`);
  console.log(`   POST /send-contact - Enviar contacto`);
  console.log(`   POST /check-number - Verificar si número existe en WhatsApp`);
  startWhatsApp();
});
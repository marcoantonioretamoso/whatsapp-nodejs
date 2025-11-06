import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Inicializar la base de datos
export async function initDatabase() {
  const db = await open({
    filename: './whatsapp.db',
    driver: sqlite3.Database
  });

  // Crear tablas
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      instance_id TEXT UNIQUE NOT NULL,
      session_data TEXT,
      status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      message TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_token ON users(token);
    CREATE INDEX IF NOT EXISTS idx_instance_user ON instances(user_id);
    CREATE INDEX IF NOT EXISTS idx_instance_id ON instances(instance_id);
  `);

  return db;
}
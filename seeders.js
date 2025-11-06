import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function runSeeders() {
  const db = await open({
    filename: './whatsapp.db',
    driver: sqlite3.Database
  });

  console.log('🌱 Ejecutando seeders...');

  // Usuarios por defecto
  const defaultUsers = [
    { token: '676311ed60ec2', name: 'Admin' },
    // { token: 'test_user_456', name: 'Usuario de Prueba' },
    // { token: 'demo_token_789', name: 'Usuario Demo' },
    // { token: 'development_001', name: 'Desarrollo 001' },
    // { token: 'production_001', name: 'Producción 001' }
  ];

  try {
    for (const user of defaultUsers) {
      const result = await db.run(
        'INSERT OR IGNORE INTO users (token, name) VALUES (?, ?)',
        user.token, user.name
      );
      
      if (result.changes > 0) {
        console.log(`✅ Usuario creado: ${user.name} (${user.token})`);
      } else {
        console.log(`📝 Usuario ya existe: ${user.name}`);
      }
    }

    console.log('🎉 Todos los seeders completados exitosamente');
  } catch (error) {
    console.error('❌ Error en los seeders:', error);
  } finally {
    await db.close();
  }
}

// Ejecutar si se llama directamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runSeeders();
}
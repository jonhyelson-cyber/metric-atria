// ==========================================
// CONFIGURAÇÃO DO FIREBASE
// ==========================================

// Configuração do projeto (dados do seu Firebase)
export const firebaseConfig = {
    apiKey: "AIzaSyDriqIDcvDWnPc6D2YGJxCN4_E9V6TaodM",
    authDomain: "atria-metric-production.firebaseapp.com",
    projectId: "atria-metric-production",
    storageBucket: "atria-metric-production.firebasestorage.app",
    messagingSenderId: "657383699546",
    appId: "1:657383699546:web:91a73edc6e8045fc6c9463"
};

// Inicialização do Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore-compat.js';

// Inicializar app
const app = initializeApp(firebaseConfig);

// Exportar instâncias
export const auth = getAuth(app);
export const db = getFirestore(app);

// Configurações adicionais
export const firebaseSettings = {
    enablePersistence: true, // Habilita cache offline
    collectionNames: {
        clientes: 'clientes',
        eventos: 'eventos',
        pagamentos: 'pagamentos',
        analises: 'analises_trafego'
    }
};

// Log de inicialização
console.log('🔥 Firebase inicializado com sucesso');
console.log('📁 Projeto:', firebaseConfig.projectId);
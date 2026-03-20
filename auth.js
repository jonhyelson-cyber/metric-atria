// ==========================================
// AUTENTICAÇÃO
// ==========================================

import { auth, db } from './firebase.js';
import { mostrarAlerta, mostrarLoading } from './utils.js';

// Estado do usuário atual
let usuarioAtual = null;
let pixelIdAtual = null;

/**
 * Observa mudanças no estado de autenticação
 * @param {Function} callback - Função chamada quando o usuário muda
 * @returns {Function} - Função para cancelar a observação
 */
export function observarAuth(callback) {
    return auth.onAuthStateChanged(async (user) => {
        if (user) {
            try {
                mostrarLoading(true);
                
                // Buscar dados do usuário no Firestore
                const doc = await db.collection('clientes').doc(user.uid).get();
                
                if (doc.exists) {
                    const data = doc.data();
                    usuarioAtual = {
                        uid: user.uid,
                        email: user.email,
                        nome: data.nome,
                        pixelID: data.pixelID,
                        plano: data.plano || 'FREE',
                        statusPagamento: data.statusPagamento || 'ativo',
                        criadoEm: data.criadoEm,
                        ultimoAcesso: data.ultimoAcesso
                    };
                    pixelIdAtual = data.pixelID;
                    
                    // Atualizar último acesso
                    await db.collection('clientes').doc(user.uid).update({
                        ultimoAcesso: new Date()
                    });
                    
                    if (callback) callback(usuarioAtual);
                } else {
                    // Documento não encontrado, fazer logout
                    console.error('Usuário não encontrado no Firestore');
                    await logout();
                    mostrarAlerta('erro', 'Usuário não encontrado. Faça login novamente.');
                }
            } catch (error) {
                console.error('Erro ao carregar usuário:', error);
                mostrarAlerta('erro', 'Erro ao carregar dados do usuário');
            } finally {
                mostrarLoading(false);
            }
        } else {
            usuarioAtual = null;
            pixelIdAtual = null;
            if (callback) callback(null);
            
            // Redirecionar para login se não estiver na página de login
            if (!window.location.pathname.includes('login.html')) {
                window.location.href = 'login.html';
            }
        }
    });
}

/**
 * Faz login com email e senha
 * @param {string} email - Email do usuário
 * @param {string} senha - Senha do usuário
 * @returns {Promise<boolean>} - true se login bem sucedido
 */
export async function login(email, senha) {
    try {
        mostrarLoading(true);
        await auth.signInWithEmailAndPassword(email, senha);
        return true;
    } catch (error) {
        console.error('Erro no login:', error);
        
        let mensagem = 'Erro ao fazer login';
        switch (error.code) {
            case 'auth/user-not-found':
                mensagem = 'Usuário não encontrado';
                break;
            case 'auth/wrong-password':
                mensagem = 'Senha incorreta';
                break;
            case 'auth/invalid-email':
                mensagem = 'Email inválido';
                break;
            case 'auth/user-disabled':
                mensagem = 'Usuário desativado';
                break;
            case 'auth/too-many-requests':
                mensagem = 'Muitas tentativas. Tente novamente mais tarde';
                break;
            case 'auth/network-request-failed':
                mensagem = 'Erro de rede. Verifique sua conexão';
                break;
            default:
                mensagem = error.message;
        }
        
        mostrarAlerta('erro', mensagem);
        return false;
    } finally {
        mostrarLoading(false);
    }
}

/**
 * Cria uma nova conta
 * @param {Object} dados - Dados do usuário
 * @returns {Promise<boolean>} - true se cadastro bem sucedido
 */
export async function cadastrar({ nome, email, senha, plano = 'FREE' }) {
    try {
        mostrarLoading(true);
        
        // Criar usuário no Firebase Auth
        const res = await auth.createUserWithEmailAndPassword(email, senha);
        
        // Gerar Pixel ID único
        const pixelId = 'AM-' + Math.random().toString(36).substr(2, 6).toUpperCase();
        
        // Salvar dados no Firestore
        await db.collection('clientes').doc(res.user.uid).set({
            nome: nome,
            email: email,
            pixelID: pixelId,
            plano: plano,
            criadoEm: new Date(),
            ultimoAcesso: new Date(),
            statusPagamento: plano === 'FREE' ? 'ativo' : 'pendente'
        });
        
        mostrarAlerta('sucesso', 'Conta criada com sucesso!');
        return true;
        
    } catch (error) {
        console.error('Erro no cadastro:', error);
        
        let mensagem = 'Erro ao criar conta';
        switch (error.code) {
            case 'auth/email-already-in-use':
                mensagem = 'Email já está em uso';
                break;
            case 'auth/invalid-email':
                mensagem = 'Email inválido';
                break;
            case 'auth/weak-password':
                mensagem = 'Senha muito fraca. Use pelo menos 6 caracteres';
                break;
            default:
                mensagem = error.message;
        }
        
        mostrarAlerta('erro', mensagem);
        return false;
    } finally {
        mostrarLoading(false);
    }
}

/**
 * Faz logout do usuário
 * @returns {Promise<boolean>} - true se logout bem sucedido
 */
export async function logout() {
    try {
        mostrarLoading(true);
        await auth.signOut();
        return true;
    } catch (error) {
        console.error('Erro no logout:', error);
        mostrarAlerta('erro', 'Erro ao sair');
        return false;
    } finally {
        mostrarLoading(false);
    }
}

/**
 * Retorna o usuário atual
 * @returns {Object|null} - Dados do usuário ou null
 */
export function getUsuarioAtual() {
    return usuarioAtual;
}

/**
 * Retorna o Pixel ID atual
 * @returns {string|null} - Pixel ID ou null
 */
export function getPixelId() {
    return pixelIdAtual;
}

/**
 * Verifica se o usuário tem acesso a uma funcionalidade
 * @param {string} funcionalidade - Nome da funcionalidade
 * @returns {boolean} - true se tem acesso
 */
export function temAcesso(funcionalidade) {
    if (!usuarioAtual) return false;
    
    const plano = usuarioAtual.plano;
    const status = usuarioAtual.statusPagamento;
    
    if (status !== 'ativo' && status !== 'trial') {
        return false;
    }
    
    // Regras de acesso por plano
    const acesso = {
        FREE: ['visao-geral', 'produtos', 'sazonalidade'],
        PRO: ['visao-geral', 'produtos', 'vendedores', 'compradores', 'regioes', 'sazonalidade', 'trafego'],
        ELITE: ['visao-geral', 'produtos', 'vendedores', 'compradores', 'regioes', 'sazonalidade', 'trafego', 'analise-avancada', 'integracoes']
    };
    
    return acesso[plano]?.includes(funcionalidade) || false;
}

/**
 * Atualiza o plano do usuário
 * @param {string} novoPlano - Novo plano
 * @returns {Promise<boolean>} - true se atualizado
 */
export async function atualizarPlano(novoPlano) {
    if (!usuarioAtual) return false;
    
    try {
        await db.collection('clientes').doc(usuarioAtual.uid).update({
            plano: novoPlano,
            statusPagamento: 'ativo'
        });
        
        usuarioAtual.plano = novoPlano;
        usuarioAtual.statusPagamento = 'ativo';
        
        mostrarAlerta('sucesso', `Plano atualizado para ${novoPlano}`);
        return true;
    } catch (error) {
        console.error('Erro ao atualizar plano:', error);
        mostrarAlerta('erro', 'Erro ao atualizar plano');
        return false;
    }
}

// Log de inicialização
console.log('🔐 Auth carregado');
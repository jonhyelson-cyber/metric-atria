// ==========================================
// FUNÇÕES UTILITÁRIAS
// ==========================================

/**
 * Mostra uma mensagem de alerta flutuante
 * @param {string} tipo - 'sucesso', 'erro', 'aviso', 'info'
 * @param {string} mensagem - Texto do alerta
 */
export function mostrarAlerta(tipo, mensagem) {
    const container = document.getElementById('alertContainer');
    if (!container) return;
    
    const alerta = document.createElement('div');
    alerta.className = `alert ${tipo}`;
    
    const icones = {
        sucesso: 'check-circle',
        erro: 'exclamation-circle',
        aviso: 'exclamation-triangle',
        info: 'info-circle'
    };
    
    alerta.innerHTML = `
        <i class="fas fa-${icones[tipo]}"></i>
        <span>${mensagem}</span>
        <button onclick="this.parentElement.remove()" style="margin-left: auto; background: none; border: none; color: inherit; cursor: pointer;">
            <i class="fas fa-times"></i>
        </button>
    `;
    
    container.appendChild(alerta);
    
    // Auto-remover após 5 segundos
    setTimeout(() => {
        if (alerta.parentNode) {
            alerta.remove();
        }
    }, 5000);
}

/**
 * Controla o overlay de loading
 * @param {boolean} mostrar - true para mostrar, false para esconder
 */
export function mostrarLoading(mostrar) {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.toggle('hidden', !mostrar);
    }
}

/**
 * Formata um valor para moeda brasileira (R$)
 * @param {number} valor - Valor a ser formatado
 * @returns {string} - Valor formatado (ex: R$ 1.234,56)
 */
export function formatarMoeda(valor) {
    if (valor === undefined || valor === null || isNaN(valor)) return 'R$ 0,00';
    return valor.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    });
}

/**
 * Formata uma data
 * @param {Date|Timestamp} data - Data a ser formatada
 * @param {string} formato - 'completo', 'data', 'hora'
 * @returns {string} - Data formatada
 */
export function formatarData(data, formato = 'completo') {
    if (!data) return '-';
    
    const d = data.seconds ? new Date(data.seconds * 1000) : new Date(data);
    
    const opcoes = {
        completo: {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        },
        data: {
            day: '2-digit', month: '2-digit', year: 'numeric'
        },
        hora: {
            hour: '2-digit', minute: '2-digit'
        }
    };
    
    return d.toLocaleDateString('pt-BR', opcoes[formato] || opcoes.completo);
}

/**
 * Agrupa um array por uma chave
 * @param {Array} array - Array a ser agrupado
 * @param {string|function} chave - Chave para agrupamento
 * @returns {Object} - Objeto agrupado
 */
export function agruparPor(array, chave) {
    return array.reduce((grupos, item) => {
        const valor = typeof chave === 'function' ? chave(item) : item[chave];
        if (!grupos[valor]) {
            grupos[valor] = [];
        }
        grupos[valor].push(item);
        return grupos;
    }, {});
}

/**
 * Calcula a variação percentual entre dois valores
 * @param {number} atual - Valor atual
 * @param {number} anterior - Valor anterior
 * @returns {string} - Variação percentual com sinal
 */
export function calcularVariacao(atual, anterior) {
    if (anterior === 0) return atual > 0 ? '+100%' : '0%';
    if (atual === 0) return '-100%';
    
    const variacao = ((atual - anterior) / anterior) * 100;
    const sinal = variacao >= 0 ? '+' : '';
    return `${sinal}${variacao.toFixed(1)}%`;
}

/**
 * Debounce para evitar múltiplas execuções
 * @param {Function} func - Função a ser executada
 * @param {number} wait - Tempo de espera em ms
 * @returns {Function} - Função com debounce
 */
export function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Gera um ID único
 * @param {string} prefixo - Prefixo do ID
 * @returns {string} - ID único
 */
export function gerarIdUnico(prefixo = '') {
    const timestamp = Date.now().toString(36);
    const aleatorio = Math.random().toString(36).substr(2, 5);
    return prefixo ? `${prefixo}_${timestamp}_${aleatorio}` : `${timestamp}_${aleatorio}`;
}

/**
 * Copia texto para a área de transferência
 * @param {string} texto - Texto a ser copiado
 * @returns {Promise<boolean>} - true se copiou com sucesso
 */
export async function copiarTexto(texto) {
    try {
        await navigator.clipboard.writeText(texto);
        mostrarAlerta('sucesso', 'Copiado para a área de transferência!');
        return true;
    } catch (err) {
        console.error('Erro ao copiar:', err);
        mostrarAlerta('erro', 'Erro ao copiar. Tente manualmente.');
        return false;
    }
}

/**
 * Valida se um valor é um preço válido
 * @param {number} valor - Valor a ser validado
 * @returns {boolean} - true se é um preço válido
 */
export function isPrecoValido(valor) {
    return valor && !isNaN(valor) && valor > 0 && valor < 100000;
}

/**
 * Extrai números de uma string
 * @param {string} str - String com números
 * @returns {number[]} - Array de números encontrados
 */
export function extrairNumeros(str) {
    const matches = str.match(/\d+([,.]\d+)?/g);
    return matches ? matches.map(m => parseFloat(m.replace(',', '.'))) : [];
}

/**
 * Retorna a cor baseada no valor (para indicadores)
 * @param {number} valor - Valor a ser avaliado
 * @param {number} meta - Meta de referência
 * @returns {string} - Nome da cor (success, warning, danger)
 */
export function getCorPorValor(valor, meta) {
    if (valor >= meta) return 'success';
    if (valor >= meta * 0.7) return 'warning';
    return 'danger';
}

/**
 * Trunca um texto com limite de caracteres
 * @param {string} texto - Texto a ser truncado
 * @param {number} limite - Limite de caracteres
 * @returns {string} - Texto truncado
 */
export function truncarTexto(texto, limite = 30) {
    if (!texto) return '';
    return texto.length > limite ? texto.substring(0, limite) + '...' : texto;
}

// Log de inicialização
console.log('🛠️ Utils carregado');
const RU_NUMBERS = {
  'один': 1, 'первый': 1, 'первого': 1, 'первом': 1,
  'два': 2, 'второй': 2, 'второго': 2,
  'три': 3, 'третий': 3, 'третьего': 3,
  'четыре': 4, 'четвертый': 4, 'четвёртый': 4, 'четвертого': 4, 'четвёртого': 4,
  'пять': 5, 'пятый': 5, 'пятого': 5,
  'шесть': 6, 'шестой': 6, 'шестого': 6,
  'семь': 7, 'седьмой': 7, 'седьмого': 7,
  'восемь': 8, 'восьмой': 8, 'восьмого': 8,
  'девять': 9, 'девятый': 9, 'девятого': 9,
  'десять': 10, 'десятый': 10, 'десятого': 10,
  'одиннадцать': 11, 'одиннадцатый': 11, 'одиннадцатого': 11,
  'двенадцать': 12, 'двенадцатый': 12, 'двенадцатого': 12,
  'тринадцать': 13, 'тринадцатый': 13, 'тринадцатого': 13,
  'четырнадцать': 14, 'четырнадцатый': 14, 'четырнадцатого': 14,
  'пятнадцать': 15, 'пятнадцатый': 15, 'пятнадцатого': 15,
  'шестнадцать': 16, 'шестнадцатый': 16, 'шестнадцатого': 16,
  'семнадцать': 17, 'семнадцатый': 17, 'семнадцатого': 17,
  'восемнадцать': 18, 'восьмнадцатый': 18, 'восемнадцатого': 18,
  'девятнадцать': 19, 'девятнадцатый': 19, 'девятнадцатого': 19,
  'двадцать': 20, 'двадцатый': 20, 'двадцатого': 20,
  'тридцать': 30, 'тридцатый': 30, 'тридцатого': 30,
  'сорок': 40, 'сороковой': 40, 'сорокового': 40,
  'пятьдесят': 50, 'пятидесятый': 50, 'пятидесятого': 50,
};

class DataParser {
  constructor(inventory) {
    this.inventory = inventory;
  }

  resolveNumber(token) {
    const t = token.toLowerCase().trim();
    if (RU_NUMBERS[t] !== undefined) return RU_NUMBERS[t];
    const n = parseInt(t);
    if (!isNaN(n)) return n;
    return null;
  }

  capitalize(name) {
    return name.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
  }

  normalizeInput(line, ctx) {
    // Если строка уже в строгом формате — возвращаем как есть
    if (line.includes(':') && line.includes('-')) {
      return line;
    }

    // Натуральный язык: "квартал 9 клетка 1 иванов с первого по второй ряд"
    let headerMatch = line.match(/квартал\s+(\S+)\s+клетка\s+(\S+)\s+(.+)/i);
    let quarter, cell, rest;
    if (headerMatch) {
      quarter = this.resolveNumber(headerMatch[1]) || headerMatch[1];
      cell = this.resolveNumber(headerMatch[2]) || headerMatch[2];
      rest = headerMatch[3].trim();
    } else if (ctx && ctx.lastQuarter && ctx.lastCell) {
      // Продолжение: квартал/клетка наследуются из предыдущей строки.
      // Например: "Лена с 5 по 10" после строки с указанным кварталом.
      quarter = ctx.lastQuarter;
      cell = ctx.lastCell;
      rest = line.trim();
    } else {
      return line;
    }

    // Заменяем русские числа на цифры (токенизация по пробелам/запятым,
    // так как \b в JS regex не работает для кириллицы без флага /u)
    rest = rest.split(/(\s+|,)/).map((tok) => {
      if (/^\s+$/.test(tok) || tok === ',') return tok;
      const num = this.resolveNumber(tok);
      return num !== null ? String(num) : tok;
    }).join('');

    // Ищем "с X по Y" (диапазон)
    const rangeMatch = rest.match(/с\s+(\d+)\s+по\s+(\d+)/i);
    if (rangeMatch) {
      const matchStart = rest.indexOf(rangeMatch[0]);
      const beforeRange = rest.substring(0, matchStart).trim();
      const afterRange = rest.substring(matchStart + rangeMatch[0].length).trim();
      const name = this.capitalize(beforeRange.replace(/\s+ряд[а-я]*$/i, '').trim());

      let rowsSpec = `с ${rangeMatch[1]} по ${rangeMatch[2]}`;
      if (afterRange) {
        // Хвост вида: "и 40", ", 40, 41", "и с 35 по 38", "ряд 40 и 41" и т.д.
        // Чистим: убираем слова "ряд/ряды/ряда" и ведущие союзы/запятые,
        // заменяем "и" между токенами на запятую.
        const cleaned = afterRange
          .replace(/\bряд[а-я]*\b/gi, ' ')
          .replace(/^[\s,и]+/i, '')
          .replace(/\s+и\s+/gi, ', ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cleaned) {
          rowsSpec += ', ' + cleaned;
        }
      }
      return `Квартал ${quarter}, Клетка ${cell}: ${name} - ${rowsSpec}`;
    }

    // Без диапазона: "иванов 1 2 3 ряд" или "иванов первый второй ряд"
    const numbers = [];
    // Разбиваем по пробелам И запятым, отбрасываем пустые
    const tokens = rest.split(/[\s,]+/).filter(Boolean);
    const nameTokens = [];
    for (const tok of tokens) {
      if (/^\d+$/.test(tok)) {
        numbers.push(tok);
      } else if (!/^(ряд|ряды|и)$/i.test(tok) && numbers.length === 0) {
        nameTokens.push(tok);
      }
    }
    if (nameTokens.length > 0 && numbers.length > 0) {
      const name = this.capitalize(nameTokens.join(' '));
      return `Квартал ${quarter}, Клетка ${cell}: ${name} - ${numbers.join(', ')}`;
    }

    return line;
  }

  parse(input, date, defaults = {}) {
    const errors = [];
    const entries = [];
    const usedRows = new Set(); // для проверки пересечений

    // Форматируем дату
    if (!this.isValidDate(date)) {
      throw new Error('Некорректный формат даты');
    }

    const estate = defaults.estate;
    if (!estate) {
      throw new Error('Не указано хозяйство');
    }
    if (!this.inventory.estates || !this.inventory.estates[estate]) {
      throw new Error(`Хозяйство "${estate}" не найдено в инвентаризации`);
    }

    // Разбиваем по блокам (квартал, клетка)
    const lines = input.split('\n').filter(l => l.trim());
    const ctx = {
      lastQuarter: defaults.quarter || null,
      lastCell: defaults.cell || null
    };

    for (let rawLine of lines) {
      const line = this.normalizeInput(rawLine, ctx);
      if (!line.includes(':')) {
        errors.push(`"Не удалось распознать строку": ${rawLine}`);
        continue;
      }

      const [header, employeesPart] = line.split(':');

      // Парсим заголовок: "Квартал N, Клетка N"
      const headerMatch = header.match(/[Кк]вартал\s+(\d+)\s*,\s*[Кк]летка\s+(\d+)/);
      if (!headerMatch) {
        errors.push(`"Некорректный формат ввода" для строки: ${line}`);
        continue;
      }

      const quarter = headerMatch[1];
      const cell = headerMatch[2]; // оставляем как строку для поиска в инвентаризации
      // Запоминаем для следующих строк-«продолжений»
      ctx.lastQuarter = quarter;
      ctx.lastCell = cell;

      // Парсим сотрудников: "Фамилия - диапазоны и перечисления"
      const employees = employeesPart.split(';').map(e => e.trim()).filter(e => e);

      for (const empStr of employees) {
        const empMatch = empStr.match(/(.+?)\s*-\s*(.+)/);
        if (!empMatch) {
          errors.push(`"Некорректный формат сотрудника": ${empStr}`);
          continue;
        }

        const [, employee, rowsStr] = empMatch;
        
        let rows;
        try {
          rows = this.parseRows(rowsStr.trim());
        } catch (error) {
          errors.push(`"Ошибка диапазона рядов" для ${employee}: ${rowsStr}`);
          continue;
        }

        // Проверяем пересечения
        let intersect = false;
        for (const row of rows) {
          const key = `${quarter}-${cell}-${row}`;
          if (usedRows.has(key)) {
            errors.push(`"Обнаружено пересечение рядов" в квартал ${quarter}, клетка ${cell}, ряд ${row}`);
            intersect = true;
            break;
          }
        }
        if (intersect) continue;
        for (const row of rows) {
          usedRows.add(`${quarter}-${cell}-${row}`);
        }

        // Количество кустов из инвентаризации
        try {
          const bushes = this.getBushesCount(estate, quarter, cell, rows);
          entries.push({
            estate,
            quarter,
            cell,
            employee: employee.trim(),
            rows,
            bushes
          });
        } catch (error) {
          errors.push(error.message);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join('\n'));
    }

    return { date, entries };
  }

  parseRows(rowsStr) {
    const rows = new Set();
    const parts = rowsStr.split(',').map(p => p.trim());

    for (const part of parts) {
      if (part.includes('по')) {
        // Формат: "с X по Y"
        const match = part.match(/[сс]\s+(\d+)\s+по\s+(\d+)/);
        if (!match) throw new Error('Invalid range format');
        
        const [, from, to] = match;
        const start = parseInt(from);
        const end = parseInt(to);
        
        if (start > end) throw new Error('Range error');
        
        for (let i = start; i <= end; i++) {
          rows.add(i);
        }
      } else {
        // Отдельное число
        const num = parseInt(part);
        if (isNaN(num)) throw new Error('Invalid number');
        rows.add(num);
      }
    }

    return Array.from(rows).sort((a, b) => a - b);
  }

  // Разбирает строку рядов вида "1-5, 9, 11" в отсортированный массив чисел.
  // На цифровой клавиатуре телефона нет запятой и пробела, поэтому принимаем
  // также точку, точку с запятой и пробел как разделители — "1-5.9.11" и
  // "1-5 9 11" работают так же, как "1-5, 9, 11".
  // Бросает понятную ошибку при неразборчивом вводе.
  parseRowList(spec) {
    const rows = new Set();
    const parts = String(spec == null ? '' : spec).split(/[,.;\s]+/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) {
      throw new Error('Укажи ряды, например: 1-5, 9, 11');
    }
    for (const part of parts) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const from = parseInt(range[1], 10);
        const to = parseInt(range[2], 10);
        if (from < 0) throw new Error(`Номер ряда не может быть отрицательным: ${part}`);
        if (from > to) throw new Error(`Неверный диапазон рядов: ${part}`);
        for (let i = from; i <= to; i++) rows.add(i);
      } else if (/^\d+$/.test(part)) {
        const n = parseInt(part, 10);
        if (n < 0) throw new Error(`Номер ряда не может быть отрицательным: ${part}`);
        rows.add(n);
      } else {
        throw new Error(`Не понял ряды: ${part}`);
      }
    }
    return Array.from(rows).sort((a, b) => a - b);
  }

  // Helper: cellData в инвентаризации может быть в двух форматах:
  //   1) старый (боевой inventory.json): просто массив [{row, bushes}, ...]
  //   2) новый (демо): { hectares, rows: [{row, bushes}, ...] }
  // Этот метод возвращает массив рядов независимо от формата.
  _rowsOf(cellData) {
    if (!cellData) return [];
    if (Array.isArray(cellData)) return cellData;
    return Array.isArray(cellData.rows) ? cellData.rows : [];
  }

  getBushesCount(estate, quarter, cell, rows) {
    const edata = this.inventory.estates[estate];
    if (!edata) {
      throw new Error(`Хозяйство "${estate}" не найдено в инвентаризации`);
    }

    const qdata = edata.quarters[quarter];
    if (!qdata) {
      throw new Error(`Ряды отсутствуют в инвентаризации для квартала ${quarter}`);
    }

    const cellData = qdata.cells[cell];
    if (!cellData) {
      throw new Error(`Клетка ${cell} не найдена в квартале ${quarter}`);
    }

    const rowsArr = this._rowsOf(cellData);
    let totalBushes = 0;
    for (const row of rows) {
      // Ряд физически на ферме существует, но в инвентаризации не отмечен —
      // нормальный случай: в ряду погибли все кусты, ждут подсадки. Считаем
      // ряд в общем количестве рядов, прибавляем 0 кустов. Когда кусты будут
      // подсажены — Натали обновит инвентаризацию и подсчёт восстановится.
      const found = rowsArr.find(item => item.row === row);
      if (!found) continue;
      totalBushes += found.bushes;
    }

    return totalBushes;
  }

  // Считает гектары для выбранных рядов клетки: доля выбранных рядов от
  // общего числа рядов клетки × гектары клетки. Возвращает число
  // (округлено до 2 знаков), либо бросает если данных нет.
  getHectaresForRows(estate, quarter, cell, rows) {
    const edata = this.inventory.estates[estate];
    if (!edata) throw new Error(`Хозяйство "${estate}" не найдено в инвентаризации`);
    const qdata = edata.quarters[quarter];
    if (!qdata) throw new Error(`Квартал ${quarter} не найден в инвентаризации`);
    const cellData = qdata.cells[cell];
    if (!cellData) throw new Error(`Клетка ${cell} не найдена в квартале ${quarter}`);
    const totalRows = this._rowsOf(cellData).length;
    if (totalRows === 0) throw new Error(`В клетке ${cell} нет рядов в инвентаризации`);
    const cellHectares = (typeof cellData === 'object' && !Array.isArray(cellData))
      ? cellData.hectares : null;
    if (cellHectares == null) {
      throw new Error(`Для клетки ${cell} не известна площадь в гектарах`);
    }
    const ha = (rows.length / totalRows) * Number(cellHectares);
    return Math.round(ha * 100) / 100;
  }

  // Ряды клетки из инвентаризации: [{row, bushes}]. Та же валидация, что getBushesCount.
  // Демо: клетка может быть объектом {hectares, rows} → берём ряды через _rowsOf.
  getCellRows(estate, quarter, cell) {
    const edata = this.inventory.estates[estate];
    if (!edata) {
      throw new Error(`Хозяйство "${estate}" не найдено в инвентаризации`);
    }
    const qdata = edata.quarters[quarter];
    if (!qdata) {
      throw new Error(`Ряды отсутствуют в инвентаризации для квартала ${quarter}`);
    }
    const cellData = qdata.cells[cell];
    if (!cellData) {
      throw new Error(`Клетка ${cell} не найдена в квартале ${quarter}`);
    }
    return this._rowsOf(cellData).map((item) => ({ row: item.row, bushes: item.bushes }));
  }

  isValidDate(dateStr) {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateStr)) return false;
    
    const date = new Date(dateStr);
    return date instanceof Date && !isNaN(date);
  }

  formatReport(date, entries, inventory) {
    const quarterCells = {};

    // Группируем по квартал-клетка
    for (const entry of entries) {
      const key = `${entry.quarter}-${entry.cell}`;
      if (!quarterCells[key]) {
        quarterCells[key] = {
          quarter: entry.quarter,
          cell: entry.cell,
          employees: [],
          totalRows: 0,
          totalBushes: 0
        };
      }
      
      quarterCells[key].employees.push({
        name: entry.employee,
        rows: entry.rows.length,
        bushes: entry.bushes
      });
      
      quarterCells[key].totalRows += entry.rows.length;
      quarterCells[key].totalBushes += entry.bushes;
    }

    // Формируем отчет
    let report = `Дата: ${date}\n\n`;

    let dayTotalRows = 0;
    let dayTotalBushes = 0;

    for (const key in quarterCells) {
      const qc = quarterCells[key];
      report += `Квартал - ${qc.quarter}, Клетка - ${qc.cell}\n`;
      
      for (const emp of qc.employees) {
        report += `${emp.name} - ${emp.rows} рядов - ${emp.bushes} кустов\n`;
      }
      
      report += `Всего: ${qc.totalRows} рядов - ${qc.totalBushes} кустов\n\n`;
      
      dayTotalRows += qc.totalRows;
      dayTotalBushes += qc.totalBushes;
    }

    report += `ВСЕГО ЗА ДЕНЬ:\nРяды: ${dayTotalRows}\nКусты: ${dayTotalBushes}`;

    return report;
  }
}

module.exports = DataParser;

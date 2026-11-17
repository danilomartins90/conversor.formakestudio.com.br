# conversor.formakestudio.com.br

Conversor de projetos 3MF do Bambu Studio (MakerWorld) para outras impressoras. Roda inteiro no navegador
(HTML, CSS e JS estáticos, publicado no GitHub Pages). O arquivo do usuário não é enviado a nenhum servidor.

## O que a conversão faz

- Copia malhas, pintura, imagens e ajustes por objeto/peça sem alterar.
- Reescreve só `Metadata/project_settings.config` com os perfis do OrcaSlicer da impressora escolhida
  (máquina + processo).
- Compara com o processo da impressora escolhida de mesma qualidade (ex.: `0.20mm Standard`), senão o
  de mesma altura de camada, senão o padrão da impressora. Esse processo não é escolhido na tela.
- Mostra só as configurações de processo em que o original difere desse processo, e o usuário escolhe,
  em cada uma, o valor do original ou o do perfil. Vêm marcados com o original os ajustes do autor
  (`different_settings_to_system`), a altura de camada e a altura da primeira camada, que são do modelo.
  O resto vem marcado com o perfil, porque é afinação da impressora de origem (velocidades,
  acelerações etc.). As incompatíveis com a impressora ficam destacadas e travadas no valor do perfil
  (o original não pode ser escolhido nem é gravado):
  - aceleração acima de `machine_max_acceleration_extruding` (a de deslocamento usa
    `machine_max_acceleration_travel` em Marlin 2, Repetier e RepRapFirmware); em porcentagem, a ponte
    é calculada sobre a parede externa e os preenchimentos sobre a aceleração padrão. Só se a
    aceleração padrão estiver ativa;
  - jerk acima do menor entre `machine_max_jerk_x`/`_y`, só se o jerk padrão estiver ativo;
  - velocidade acima do menor entre `machine_max_speed_x`/`_y` ou, para as linhas de extrusão, acima
    do fluxo máximo do filamento (`filament_max_volumetric_speed` ÷ (altura de camada × largura da
    linha)). Nunca abaixo do valor do próprio perfil de destino;
  - altura de camada fora do limite do bico (`min_layer_height`/`max_layer_height`);
  - chaves que não existem no OrcaSlicer.

  As regras de limite seguem as do conversor antigo usado como referência. Configurações que o
  perfil de destino não define só aparecem se o autor as alterou, porque o valor padrão interno do
  OrcaSlicer não está nos dados gerados.
- As configurações de G-code da aba "Outros" do processo (opções de G-code, formato do nome do arquivo,
  G-code de mudança de tipo de extrusão, scripts de pós-processamento, plugins e notas) não aparecem na
  tabela e saem sempre com o valor da impressora de destino.
- Os filamentos saem iguais ao 3MF original (temperaturas, avanço de pressão, fluxo, ajustes do autor no
  filamento). A troca pelo filamento da impressora é feita no fatiador.
- Reposiciona os objetos de cada mesa no centro da mesa de destino e move a torre de purga junto.
- Impressora sem troca de filamento no OrcaSlicer: junta as cores num filamento e remove a pintura.
- Remove G-code fatiado que venha no 3MF (`Metadata/plate_N.gcode`).

Ao abrir o arquivo, o fatiador procura os presets pelo nome gravado. Se tiver presets com o mesmo nome,
usa os valores dele e mantém só as chaves listadas como ajustes do autor. Se não tiver, usa os valores
gravados no arquivo.

## Limitações

- Impressoras com mais de um bico (H2D, X2D, H2C, IDEX, trocadores de ferramenta) não são listadas.
- Converte o projeto inteiro. Não exporta uma mesa por arquivo.
- Ajustes do autor na impressora de origem não são levados (são mostrados na tela).
- A senha (`js/auth.js`) é só uma barreira visual: o código do site é público.

## Estrutura

```
index.html, style.css      página (mesmo visual da calculadora)
js/auth.js                 portão de senha
js/app.js                  interface
js/converter.js            leitura do 3MF e conversão (sem DOM, roda também no Node)
js/zip.js                  leitura/gravação de ZIP
data/                      perfis gerados a partir do OrcaSlicer
tools/generate-profiles.mjs gerador de data/
```

## Versão do site e cache

A versão atual é a que aparece no rodapé da página ("Versão: 1.0.0"). Todos os arquivos que a página
carrega levam a versão na URL (`style.css?version=1.0.0`, `js/app.js?version=1.0.0`, o logo, os `import`
entre os JS e os `.json` de `data/`). Quando a versão muda, as URLs mudam e o navegador baixa tudo de novo
em vez de usar o cache.

A versão fica em três arquivos:

| Arquivo | Onde |
| --- | --- |
| `index.html` | `?version=` do CSS, do logo e dos dois `<script>`, e o texto "Versão:" do rodapé |
| `js/app.js` | `const APP_VERSION` (usada nos `.json` de `data/` e no rodapé) e os dois `import` |
| `js/converter.js` | `import` do `zip.js` |

### Publicar uma versão nova

1. Faça as alterações e teste localmente (ver "Testar localmente").
2. Suba a versão em todos os lugares de uma vez (exemplo de 1.0.0 para 1.0.1):

   ```bash
   sed -i 's/1\.0\.0/1.0.1/g' index.html js/app.js js/converter.js
   ```

3. Confira se todas as ocorrências ficaram com a versão nova:

   ```bash
   grep -rn "version=\|APP_VERSION =\|Versão:" index.html js
   ```

4. Faça commit e push na `main`. O GitHub Pages publica em seguida.

O GitHub Pages envia `Cache-Control: max-age=600` para todos os arquivos, inclusive o `index.html`, e não
permite mudar isso. Então, logo depois de publicar, um navegador que já tinha aberto o site pode mostrar a
página antiga por até 10 minutos (ou até um recarregamento forçado, Ctrl+Shift+R). Quando ele busca o
`index.html` novo, todos os outros arquivos vêm na versão nova.

## Atualizar os perfis (nova versão do OrcaSlicer)

Os dados atuais vêm do OrcaSlicer **v2.5.1** (tag `v2.5.1`, commit `eef7710`). O gerador lê os perfis
(`resources/profiles`), as listas de configurações do código C++ (`src/libslic3r`), a tradução pt_BR
(`localization/i18n/pt_BR`) e o `version.inc`. Requer Node 18 ou mais novo.

1. Veja o nome exato da tag da versão nova em
   [releases do OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer/releases). Nos comandos abaixo,
   troque `v2.6.0` por ela.

2. Baixe só as pastas necessárias para `insumos_para_desenvolvimento/` (ignorada pelo Git):

   ```bash
   mkdir -p insumos_para_desenvolvimento
   git clone --depth 1 --branch v2.6.0 --filter=blob:none --sparse https://github.com/OrcaSlicer/OrcaSlicer.git insumos_para_desenvolvimento/OrcaSlicer-2.6.0
   git -C insumos_para_desenvolvimento/OrcaSlicer-2.6.0 sparse-checkout set resources/profiles src/libslic3r localization/i18n/pt_BR
   ```

3. Gere os perfis:

   ```bash
   node tools/generate-profiles.mjs --orca insumos_para_desenvolvimento/OrcaSlicer-2.6.0 --verbose
   ```

   O script substitui os `.json` de `data/machines` e `data/processes` e reescreve `data/printers.json`,
   `data/keys.json`, `data/labels.json` e `data/meta.json`. No fim mostra quantas impressoras e processos
   gerou e os avisos (com `--verbose`, a lista dos avisos). A versão do OrcaSlicer é lida do
   `version.inc` e aparece no rodapé do site.

   Se o código do OrcaSlicer mudar de estrutura numa versão nova, o script para com um erro (por exemplo
   `marker not found: ...`) em vez de gerar dados errados. Nesse caso o gerador precisa ser ajustado.

4. Atualize neste README a versão de origem dos dados (a linha "Os dados atuais vêm do OrcaSlicer ...").

5. Suba a versão do site e publique (ver "Publicar uma versão nova"). Sem isso, o navegador pode continuar
   usando os perfis antigos do cache.

## Testar localmente

```bash
python3 -m http.server 8765
```

Abra `http://127.0.0.1:8765/`. Abrir o `index.html` direto do disco não funciona, porque os perfis são
carregados com `fetch`.

## Licença dos dados

Os arquivos de `data/` são derivados dos perfis do OrcaSlicer, distribuídos sob a GNU AGPL-3.0.

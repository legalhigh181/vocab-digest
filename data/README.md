# data/ 词表

这个目录由 `vocab-english init` 首次运行时自动生成（幂等：**已存在的文件永远不会被覆盖**），
之后随你自己改。所有文件都是纯文本，UTF-8 编码，可以用记事本编辑。

| 文件 | 作用 | 格式 |
|---|---|---|
| `stopword.txt` | 停用词，**不进正文** | 一行一个；一行里用空格/逗号写多个也认 |
| `known/known.txt` | 已掌握的词，直接过滤掉 | 同上 |
| `base/base.txt` | 基础词，用于「难度」标签 | 同上 |
| `pos.json` | 词性表，优先级最高 | `{"word": "n."}` |
| `lemmatize.exceptions.json` | 词形还原例外（告诉程序「别把 us 还原成 u」） | `{"us": "us"}` |
| `lemmatize.freqrank` | 可选，词频表（高频在前），用于候选排序 | 一行一个词 |

常见用法：

- **不想看到某个词**：加进 `known/known.txt`。
- **想让某个词保留但不想它被当成生词**：加进 `stopword.txt`。
- **固定词性**：写进 `pos.json`，例如 `{"gradient": "n.", "converge": "v."}`。
- **某个词被错误还原**：写进 `lemmatize.exceptions.json`，值写成它自己即可。

改完直接重跑 `digest` 或 `render --run <runDir>` 就生效。

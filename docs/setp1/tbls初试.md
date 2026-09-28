就是将tbls作为底层工具，再次基础上进行治理，
出发点就是，用户可以开一个workspace，内部有design模块和db模块，用户可以在design模块设计自己需要的数据模型，
db模块基于tbls获取数据库，然后可视化，
然后db模块和design模块统一一个抽象模型
你觉得怎么样


tbls 可以把一份 JSON 当作数据源。这意味着你可以把设计模型也导出成 tbls 格式的 JSON，再让 tbls 生成文档、Mermaid 或 SVG。这样设计模型和开发模型可以共用同一套文档渲染，不用自己写。
这点我觉得很不错，就一tbls的json格式为数据源，后续就是design阶段一个json文本，db模块用tbls导出json格式
以tbls现有的为标准


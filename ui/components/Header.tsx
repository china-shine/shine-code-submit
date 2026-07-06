import { Icon } from "./Icon";
import { Status } from "./Status";

/** 顶栏：标题 + 右侧运行状态（Step 5 移除 log toggle，日志已收进「系统」模块）。 */
export function Header() {
  return (
    <header>
      <div className="title">
        <Icon name="diamond" size={14} />
        <span>Shine Code Submit</span>
      </div>
      <Status />
    </header>
  );
}

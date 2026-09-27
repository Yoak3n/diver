//! 任务状态机纯迁移（委派一期）：建单 / 起跑 / 终态 / 恢复标记（无 IO，可单测）。

use super::types::{
    now_secs, TaskRecord, TasksFile, STATUS_CANCELLED, STATUS_DONE, STATUS_FAILED,
    STATUS_QUEUED, STATUS_RUNNING, STATUS_STUCK, STATUS_UNKNOWN,
};

/// 终态判定。
pub fn is_final(status: &str) -> bool {
    matches!(
        status,
        STATUS_DONE | STATUS_FAILED | STATUS_STUCK | STATUS_CANCELLED | STATUS_UNKNOWN
    )
}

/// 建单（queued）：id 递增分配 `task-N`。
pub fn create(
    file: &mut TasksFile,
    instance_id: &str,
    agent: &str,
    task_text: &str,
    command: &str,
    timeout_secs: Option<u64>,
) -> TaskRecord {
    let n = file.tasks.len() + 1;
    let mut id = format!("task-{n}");
    let mut i = n;
    while file.tasks.iter().any(|t| t.id == id) {
        i += 1;
        id = format!("task-{i}");
    }
    let record = TaskRecord {
        id,
        instance_id: instance_id.to_string(),
        agent: agent.to_string(),
        task_text: task_text.to_string(),
        status: STATUS_QUEUED.to_string(),
        command: command.to_string(),
        pid: None,
        created_at: now_secs(),
        started_at: None,
        ended_at: None,
        exit_code: None,
        summary: String::new(),
        timeout_secs,
    };
    file.tasks.push(record.clone());
    record
}

fn find_mut<'a>(file: &'a mut TasksFile, id: &str) -> Result<&'a mut TaskRecord, String> {
    file.tasks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("未找到任务「{id}」"))
}

/// 起跑（queued → running）：记 pid 与起跑时间。
pub fn mark_running(file: &mut TasksFile, id: &str, pid: u32) -> Result<TaskRecord, String> {
    let t = find_mut(file, id)?;
    if t.status != STATUS_QUEUED {
        return Err(format!("任务「{id}」状态为 {}，不能起跑", t.status));
    }
    t.status = STATUS_RUNNING.to_string();
    t.pid = Some(pid);
    t.started_at = Some(now_secs());
    Ok(t.clone())
}

/// 终态（running/queued → done|failed|stuck|cancelled）：记退出码与摘要。
pub fn finish(
    file: &mut TasksFile,
    id: &str,
    status: &str,
    exit_code: Option<i32>,
    summary: &str,
) -> Result<TaskRecord, String> {
    if !is_final(status) || status == STATUS_UNKNOWN {
        return Err(format!("「{status}」不是可写入的终态"));
    }
    let t = find_mut(file, id)?;
    if t.status != STATUS_RUNNING && t.status != STATUS_QUEUED {
        return Err(format!("任务「{id}」状态为 {}，不能写终态", t.status));
    }
    t.status = status.to_string();
    t.exit_code = exit_code;
    t.summary = summary.to_string();
    t.ended_at = Some(now_secs());
    Ok(t.clone())
}

/// 恢复标记（running → unknown）：壳重启后监督句柄已失，明示结果不可知。
pub fn mark_unknown(file: &mut TasksFile, id: &str) -> Result<TaskRecord, String> {
    let t = find_mut(file, id)?;
    if t.status != STATUS_RUNNING {
        return Err(format!("任务「{id}」状态为 {}，无需标记 unknown", t.status));
    }
    t.status = STATUS_UNKNOWN.to_string();
    t.ended_at = Some(now_secs());
    t.summary = "壳层重启，监督中断，结果不可知。可核对后重派或忽略。".to_string();
    Ok(t.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_with_one() -> (TasksFile, String) {
        let mut f = TasksFile::default();
        let t = create(&mut f, "default", "dsh", "跑测试", "cmd /C dsh", Some(1800));
        assert_eq!(t.status, "queued");
        (f, t.id)
    }

    #[test]
    fn full_lifecycle_queued_running_done() {
        let (mut f, id) = file_with_one();
        mark_running(&mut f, &id, 4242).unwrap();
        assert_eq!(find_mut(&mut f, &id).unwrap().status, "running");
        assert_eq!(find_mut(&mut f, &id).unwrap().pid, Some(4242));
        let done = finish(&mut f, &id, STATUS_DONE, Some(0), "输出尾部").unwrap();
        assert_eq!(done.status, "done");
        assert_eq!(done.summary, "输出尾部");
        assert!(is_final(&done.status));
    }

    #[test]
    fn terminal_and_unknown_guards() {
        let (mut f, id) = file_with_one();
        // queued 直接终态允许（spawn 失败留痕）
        finish(&mut f, &id, STATUS_FAILED, None, "spawn 失败").unwrap();
        assert!(finish(&mut f, &id, STATUS_DONE, None, "").is_err(), "终态不可再迁移");
        assert!(mark_unknown(&mut f, &id).is_err(), "非 running 不可标 unknown");
        assert!(finish(&mut f, &id, STATUS_UNKNOWN, None, "").is_err(), "unknown 不是可写终态");
    }

    #[test]
    fn running_only_unknown_and_ids_increment() {
        let (mut f, id) = file_with_one();
        mark_running(&mut f, &id, 1).unwrap();
        let unknown = mark_unknown(&mut f, &id).unwrap();
        assert_eq!(unknown.status, "unknown");
        assert!(unknown.summary.contains("不可知"), "恢复摘要要点明不可知");
        // id 递增：重建后 task-2
        let t2 = create(&mut f, "default", "dsh", "再跑", "cmd", None);
        assert_eq!(t2.id, "task-2");
    }

    #[test]
    fn stuck_and_cancelled_are_writable_terminals() {
        for status in [STATUS_STUCK, STATUS_CANCELLED] {
            let (mut f, id) = file_with_one();
            mark_running(&mut f, &id, 7).unwrap();
            let t = finish(&mut f, &id, status, None, "").unwrap();
            assert_eq!(t.status, status);
        }
    }
}

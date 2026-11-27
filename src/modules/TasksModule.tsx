import React, { useEffect, useMemo, useRef, useState } from 'react';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import {
  CheckCircle2,
  ClipboardList,
  Clock,
  MessageSquare,
  Plus,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType, storage } from '../lib/firebase';
import { formatTimestamp, generateId, todayIsoDate } from '../lib/utils';
import { logActivity, pushNotification } from '../lib/erpActions';
import { getRoleDisplayLabel } from '../lib/roles';
import {
  clearFormDraft,
  formatDraftAge,
  getTaskAssignDraftKey,
  getTaskDetailDraftKey,
  loadFormDraft,
  saveFormDraft,
} from '../lib/formDrafts';
import {
  Employee,
  TaskCategory,
  TaskItem,
  TaskPriority,
  TaskStatus,
  TaskUpdate,
  UserAccount,
} from '../types/erp';

interface TasksModuleProps {
  currentUser: UserAccount;
  isAdminView: boolean;
  tasks: TaskItem[];
  taskUpdates: TaskUpdate[];
  employees: Employee[];
}

const CATEGORIES: TaskCategory[] = [
  'Sales',
  'Customer Visit',
  'Stock Management',
  'Delivery',
  'Collection',
  'Reporting',
  'General Work',
];

const PRIORITIES: TaskPriority[] = ['Low', 'Medium', 'High', 'Urgent'];

interface TaskAssignDraft {
  title: string;
  description: string;
  instructions: string;
  selectedAssigneeUids: string[];
  teamName: string;
  category: TaskCategory;
  priority: TaskPriority;
  startDate: string;
  deadline: string;
  adminRemarks: string;
}

interface TaskDetailDraft {
  progressInput: number;
  commentText: string;
  proofNotes: string;
  extDate: string;
  extReason: string;
  rejectReason: string;
  uploadedProofUrl: string;
  uploadedProofName: string;
}

function hasTaskAssignDraftChanges(
  d: TaskAssignDraft,
  editingTask: TaskItem | null
): boolean {
  if (editingTask) {
    return Boolean(
      d.title !== editingTask.title ||
        d.description !== (editingTask.description || '') ||
        d.instructions !== (editingTask.instructions || '') ||
        JSON.stringify(d.selectedAssigneeUids) !==
          JSON.stringify([editingTask.assignedToUid]) ||
        d.teamName !== (editingTask.teamName || '') ||
        d.category !== editingTask.category ||
        d.priority !== editingTask.priority ||
        d.startDate !== editingTask.startDate ||
        d.deadline !== editingTask.deadline ||
        d.adminRemarks !== (editingTask.adminRemarks || '')
    );
  }
  const today = todayIsoDate();
  return Boolean(
    d.title.trim() ||
      d.description.trim() ||
      d.instructions.trim() ||
      d.selectedAssigneeUids.length > 0 ||
      d.teamName.trim() ||
      d.adminRemarks.trim() ||
      d.category !== 'Customer Visit' ||
      d.priority !== 'Medium' ||
      d.startDate !== today ||
      d.deadline !== today
  );
}

function hasTaskDetailDraftContent(
  d: TaskDetailDraft,
  baselineProgress: number
): boolean {
  return Boolean(
    d.commentText.trim() ||
      d.proofNotes.trim() ||
      d.extDate.trim() ||
      d.extReason.trim() ||
      d.rejectReason.trim() ||
      d.uploadedProofUrl.trim() ||
      d.uploadedProofName.trim() ||
      d.progressInput !== baselineProgress
  );
}

export const TasksModule: React.FC<TasksModuleProps> = ({
  currentUser,
  isAdminView,
  tasks,
  taskUpdates,
  employees,
}) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [showPerformance, setShowPerformance] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);

  // Create/Edit state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [selectedAssigneeUids, setSelectedAssigneeUids] = useState<string[]>([]);
  const [teamName, setTeamName] = useState('');
  const [category, setCategory] = useState<TaskCategory>('Customer Visit');
  const [priority, setPriority] = useState<TaskPriority>('Medium');
  const [startDate, setStartDate] = useState(todayIsoDate());
  const [deadline, setDeadline] = useState(todayIsoDate());
  const [adminRemarks, setAdminRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Detail modal state
  const [commentText, setCommentText] = useState('');
  const [progressInput, setProgressInput] = useState(50);
  const [proofNotes, setProofNotes] = useState('');
  const [extDate, setExtDate] = useState('');
  const [extReason, setExtReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadedProofUrl, setUploadedProofUrl] = useState('');
  const [uploadedProofName, setUploadedProofName] = useState('');

  // LocalStorage draft persistence state
  const [assignDraftRestored, setAssignDraftRestored] = useState(false);
  const [assignDraftSavedAt, setAssignDraftSavedAt] = useState<number | null>(null);
  const [savedAssignDraftMeta, setSavedAssignDraftMeta] = useState<{
    savedAt: number;
    title: string;
    category: TaskCategory;
    assigneeCount: number;
  } | null>(null);

  const [detailDraftRestored, setDetailDraftRestored] = useState(false);
  const [detailDraftSavedAt, setDetailDraftSavedAt] = useState<number | null>(null);
  const [detailDraftVersion, setDetailDraftVersion] = useState(0);

  const assignableEmployees = employees.filter((e) => e.status === 'Active');

  const refreshSavedAssignDraftBanner = () => {
    const stored = loadFormDraft<TaskAssignDraft>(
      getTaskAssignDraftKey(currentUser.uid)
    );
    if (stored && hasTaskAssignDraftChanges(stored.data, null)) {
      setSavedAssignDraftMeta({
        savedAt: stored.savedAt,
        title: stored.data.title,
        category: stored.data.category,
        assigneeCount: stored.data.selectedAssigneeUids.length,
      });
    } else {
      setSavedAssignDraftMeta(null);
    }
  };

  useEffect(() => {
    refreshSavedAssignDraftBanner();
  }, [currentUser.uid]);

  const applyAssignDraft = (draft: TaskAssignDraft, savedAt: number) => {
    const validUidSet = new Set(assignableEmployees.map((e) => e.uid || e.id));
    const safeAssignees = Array.isArray(draft.selectedAssigneeUids)
      ? draft.selectedAssigneeUids.filter((uid) => validUidSet.has(uid))
      : [];
    setTitle(draft.title || '');
    setDescription(draft.description || '');
    setInstructions(draft.instructions || '');
    setSelectedAssigneeUids(safeAssignees);
    setTeamName(draft.teamName || '');
    setCategory(draft.category || 'Customer Visit');
    setPriority(draft.priority || 'Medium');
    setStartDate(draft.startDate || todayIsoDate());
    setDeadline(draft.deadline || todayIsoDate());
    setAdminRemarks(draft.adminRemarks || '');
    setAssignDraftRestored(true);
    setAssignDraftSavedAt(savedAt);
  };

  const openCreate = () => {
    setEditingTask(null);
    setErr('');
    const stored = loadFormDraft<TaskAssignDraft>(
      getTaskAssignDraftKey(currentUser.uid)
    );
    if (stored && hasTaskAssignDraftChanges(stored.data, null)) {
      applyAssignDraft(stored.data, stored.savedAt);
    } else {
      setTitle('');
      setDescription('');
      setInstructions('');
      setSelectedAssigneeUids([]);
      setTeamName('');
      setCategory('Customer Visit');
      setPriority('Medium');
      setStartDate(todayIsoDate());
      setDeadline(todayIsoDate());
      setAdminRemarks('');
      setAssignDraftRestored(false);
      setAssignDraftSavedAt(null);
    }
    setShowCreateModal(true);
  };

  const openEdit = (t: TaskItem) => {
    setEditingTask(t);
    setErr('');
    const stored = loadFormDraft<TaskAssignDraft>(
      getTaskAssignDraftKey(currentUser.uid, t.id)
    );
    if (stored && hasTaskAssignDraftChanges(stored.data, t)) {
      applyAssignDraft(stored.data, stored.savedAt);
    } else {
      setTitle(t.title);
      setDescription(t.description || '');
      setInstructions(t.instructions || '');
      setSelectedAssigneeUids([t.assignedToUid]);
      setTeamName(t.teamName || '');
      setCategory(t.category);
      setPriority(t.priority);
      setStartDate(t.startDate);
      setDeadline(t.deadline);
      setAdminRemarks(t.adminRemarks || '');
      setAssignDraftRestored(false);
      setAssignDraftSavedAt(null);
    }
    setShowCreateModal(true);
  };

  const handleDiscardAssignDraft = () => {
    clearFormDraft(getTaskAssignDraftKey(currentUser.uid, editingTask?.id));
    setAssignDraftRestored(false);
    setAssignDraftSavedAt(null);
    if (editingTask) {
      setTitle(editingTask.title);
      setDescription(editingTask.description || '');
      setInstructions(editingTask.instructions || '');
      setSelectedAssigneeUids([editingTask.assignedToUid]);
      setTeamName(editingTask.teamName || '');
      setCategory(editingTask.category);
      setPriority(editingTask.priority);
      setStartDate(editingTask.startDate);
      setDeadline(editingTask.deadline);
      setAdminRemarks(editingTask.adminRemarks || '');
    } else {
      setTitle('');
      setDescription('');
      setInstructions('');
      setSelectedAssigneeUids([]);
      setTeamName('');
      setCategory('Customer Visit');
      setPriority('Medium');
      setStartDate(todayIsoDate());
      setDeadline(todayIsoDate());
      setAdminRemarks('');
    }
    refreshSavedAssignDraftBanner();
  };

  const openTaskDetail = (t: TaskItem) => {
    setSelectedTask(t);
    const baseline = t.progressPct || 50;
    const stored = loadFormDraft<TaskDetailDraft>(
      getTaskDetailDraftKey(currentUser.uid, t.id)
    );
    if (stored && hasTaskDetailDraftContent(stored.data, baseline)) {
      setProgressInput(
        typeof stored.data.progressInput === 'number'
          ? stored.data.progressInput
          : baseline
      );
      setCommentText(stored.data.commentText || '');
      setProofNotes(stored.data.proofNotes || '');
      setExtDate(stored.data.extDate || '');
      setExtReason(stored.data.extReason || '');
      setRejectReason(stored.data.rejectReason || '');
      setUploadedProofUrl(stored.data.uploadedProofUrl || '');
      setUploadedProofName(stored.data.uploadedProofName || '');
      setDetailDraftRestored(true);
      setDetailDraftSavedAt(stored.savedAt);
    } else {
      setProgressInput(baseline);
      setCommentText('');
      setProofNotes('');
      setExtDate('');
      setExtReason('');
      setRejectReason('');
      setUploadedProofUrl('');
      setUploadedProofName('');
      setDetailDraftRestored(false);
      setDetailDraftSavedAt(null);
    }
  };

  const handleDiscardDetailDraft = () => {
    if (!selectedTask) return;
    clearFormDraft(getTaskDetailDraftKey(currentUser.uid, selectedTask.id));
    setProgressInput(selectedTask.progressPct || 50);
    setCommentText('');
    setProofNotes('');
    setExtDate('');
    setExtReason('');
    setRejectReason('');
    setUploadedProofUrl('');
    setUploadedProofName('');
    setDetailDraftRestored(false);
    setDetailDraftSavedAt(null);
    setDetailDraftVersion((v) => v + 1);
  };

  // Auto-cache Assign/Edit form draft & Execution/Detail form draft + flush on unload
  const latestAssignDraftRef = useRef<{
    key: string;
    draft: TaskAssignDraft;
    editingTask: TaskItem | null;
    active: boolean;
  }>({
    key: getTaskAssignDraftKey(currentUser.uid),
    draft: {
      title,
      description,
      instructions,
      selectedAssigneeUids,
      teamName,
      category,
      priority,
      startDate,
      deadline,
      adminRemarks,
    },
    editingTask: null,
    active: false,
  });

  latestAssignDraftRef.current = {
    key: getTaskAssignDraftKey(currentUser.uid, editingTask?.id),
    draft: {
      title,
      description,
      instructions,
      selectedAssigneeUids,
      teamName,
      category,
      priority,
      startDate,
      deadline,
      adminRemarks,
    },
    editingTask,
    active: showCreateModal,
  };

  const latestDetailDraftRef = useRef<{
    key: string;
    draft: TaskDetailDraft;
    baselineProgress: number;
    active: boolean;
  }>({
    key: '',
    draft: {
      progressInput,
      commentText,
      proofNotes,
      extDate,
      extReason,
      rejectReason,
      uploadedProofUrl,
      uploadedProofName,
    },
    baselineProgress: 50,
    active: false,
  });

  latestDetailDraftRef.current = {
    key: selectedTask
      ? getTaskDetailDraftKey(currentUser.uid, selectedTask.id)
      : '',
    draft: {
      progressInput,
      commentText,
      proofNotes,
      extDate,
      extReason,
      rejectReason,
      uploadedProofUrl,
      uploadedProofName,
    },
    baselineProgress: selectedTask?.progressPct || 50,
    active: Boolean(selectedTask),
  };

  const persistCurrentAssignDraft = () => {
    const { key, draft, editingTask: editTarget, active } =
      latestAssignDraftRef.current;
    if (!active) return;
    if (!hasTaskAssignDraftChanges(draft, editTarget)) {
      clearFormDraft(key);
      setAssignDraftSavedAt(null);
      return;
    }
    if (saveFormDraft(key, draft)) {
      setAssignDraftSavedAt(Date.now());
    }
  };

  const persistCurrentDetailDraft = () => {
    const { key, draft, baselineProgress, active } =
      latestDetailDraftRef.current;
    if (!active || !key) return;
    if (!hasTaskDetailDraftContent(draft, baselineProgress)) {
      clearFormDraft(key);
      setDetailDraftSavedAt(null);
      setDetailDraftVersion((v) => v + 1);
      return;
    }
    if (saveFormDraft(key, draft)) {
      setDetailDraftSavedAt(Date.now());
      setDetailDraftVersion((v) => v + 1);
    }
  };

  const closeCreateModal = () => {
    persistCurrentAssignDraft();
    setShowCreateModal(false);
    refreshSavedAssignDraftBanner();
  };

  const closeDetailModal = () => {
    persistCurrentDetailDraft();
    setSelectedTask(null);
    setDetailDraftVersion((v) => v + 1);
  };

  useEffect(() => {
    if (!showCreateModal) return;
    const timer = window.setTimeout(persistCurrentAssignDraft, 200);
    return () => window.clearTimeout(timer);
  }, [
    showCreateModal,
    editingTask?.id,
    currentUser.uid,
    title,
    description,
    instructions,
    selectedAssigneeUids,
    teamName,
    category,
    priority,
    startDate,
    deadline,
    adminRemarks,
  ]);

  useEffect(() => {
    if (!selectedTask) return;
    const timer = window.setTimeout(persistCurrentDetailDraft, 200);
    return () => window.clearTimeout(timer);
  }, [
    selectedTask?.id,
    selectedTask?.progressPct,
    currentUser.uid,
    progressInput,
    commentText,
    proofNotes,
    extDate,
    extReason,
    rejectReason,
    uploadedProofUrl,
    uploadedProofName,
  ]);

  useEffect(() => {
    const flush = () => {
      persistCurrentAssignDraft();
      persistCurrentDetailDraft();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!title.trim() || selectedAssigneeUids.length === 0) {
      setErr('Task title and at least one assignee are required.');
      return;
    }
    setSaving(true);
    try {
      if (editingTask) {
        const targetUid = selectedAssigneeUids[0];
        const targetEmp = assignableEmployees.find(
          (emp) => (emp.uid || emp.id) === targetUid
        );
        await updateDoc(doc(db, 'tasks', editingTask.id), {
          title: title.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          assignedToUid: targetUid,
          assignedToName: targetEmp?.fullName || editingTask.assignedToName,
          teamName: teamName.trim(),
          category,
          priority,
          startDate,
          deadline,
          adminRemarks: adminRemarks.trim(),
          updatedAt: serverTimestamp(),
        });
        setMsg('Task updated.');
      } else {
        for (const uid of selectedAssigneeUids) {
          const emp = assignableEmployees.find((em) => (em.uid || em.id) === uid);
          const taskId = generateId('tsk');
          await setDoc(doc(db, 'tasks', taskId), {
            id: taskId,
            title: title.trim(),
            description: description.trim(),
            instructions: instructions.trim(),
            assignedToUid: uid,
            assignedToName: emp?.fullName || 'Employee',
            teamName: teamName.trim(),
            category,
            priority,
            startDate,
            deadline,
            status: 'Assigned',
            progressPct: 0,
            adminRemarks: adminRemarks.trim(),
            createdByUid: currentUser.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          await pushNotification({
            recipientUid: uid,
            title: `New Task Assigned: ${title.trim()}`,
            message: `${category} (${priority} priority) · Deadline: ${deadline}`,
            category: 'Task',
            severity: priority === 'Urgent' ? 'urgent' : 'info',
            linkTab: 'my-tasks',
          });
          await logActivity({
            userId: currentUser.uid,
            employeeName: currentUser.displayName,
            action: 'Task Assigned',
            entityType: 'task',
            entityId: taskId,
            details: `Assigned "${title.trim()}" to ${emp?.fullName || uid}`,
          });
        }
        setMsg(`Assigned task to ${selectedAssigneeUids.length} team member(s).`);
      }
      clearFormDraft(getTaskAssignDraftKey(currentUser.uid, editingTask?.id));
      setAssignDraftRestored(false);
      setAssignDraftSavedAt(null);
      setShowCreateModal(false);
      refreshSavedAssignDraftBanner();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'tasks');
    } finally {
      setSaving(false);
    }
  };

  const addTaskUpdateLog = async (
    task: TaskItem,
    actionType: string,
    comment: string,
    progress?: number,
    attachmentUrl?: string,
    attachmentName?: string
  ) => {
    const upId = generateId('tup');
    await setDoc(doc(db, 'taskUpdates', upId), {
      id: upId,
      taskId: task.id,
      authorUid: currentUser.uid,
      authorName: currentUser.displayName,
      actionType,
      comment: comment.slice(0, 800),
      ...(typeof progress === 'number' ? { progressPct: progress } : {}),
      ...(attachmentUrl ? { attachmentUrl } : {}),
      ...(attachmentName ? { attachmentName } : {}),
      createdAt: serverTimestamp(),
    });
  };

  const handleStatusTransition = async (
    task: TaskItem,
    nextStatus: TaskStatus,
    extra: Record<string, any> = {},
    logText?: string
  ) => {
    try {
      await updateDoc(doc(db, 'tasks', task.id), {
        status: nextStatus,
        ...extra,
        updatedAt: serverTimestamp(),
      });
      await addTaskUpdateLog(
        task,
        nextStatus,
        logText || `Task moved to ${nextStatus}`,
        extra.progressPct
      );
      await logActivity({
        userId: currentUser.uid,
        employeeName: currentUser.displayName,
        action:
          nextStatus === 'In Progress'
            ? 'Task Started'
            : nextStatus === 'Completed' || nextStatus === 'Pending Approval'
            ? 'Task Completed'
            : 'Task Updated',
        entityType: 'task',
        entityId: task.id,
        details: `${task.title} -> ${nextStatus}`,
      });

      if (nextStatus === 'Pending Approval' || nextStatus === 'Completed') {
        await pushNotification({
          recipientUid: task.createdByUid,
          title: `Task Awaiting Approval: ${task.title}`,
          message: `${currentUser.displayName} submitted task completion proof.`,
          category: 'Task',
          severity: 'info',
          linkTab: 'tasks',
        });
      } else if (nextStatus === 'Approved' || nextStatus === 'Rejected') {
        await pushNotification({
          recipientUid: task.assignedToUid,
          title: `Task ${nextStatus}: ${task.title}`,
          message:
            nextStatus === 'Rejected'
              ? `Reason: ${extra.rejectionReason || 'Needs revision'}`
              : 'Completion verified and approved.',
          category: 'Task',
          severity: nextStatus === 'Rejected' ? 'warning' : 'info',
          linkTab: 'my-tasks',
        });
      }

      setMsg(`Task "${task.title}" updated to ${nextStatus}.`);
      setSelectedTask((prev) =>
        prev && prev.id === task.id ? { ...prev, status: nextStatus, ...extra } : prev
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `tasks/${task.id}`);
    }
  };

  const handleProofUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedTask) return;
    setUploadingFile(true);
    try {
      const storageRef = ref(
        storage,
        `task-proofs/${selectedTask.id}/${Date.now()}_${file.name}`
      );
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      setUploadedProofUrl(url);
      setUploadedProofName(file.name);
      setMsg(`Uploaded proof attachment: ${file.name}`);
    } catch {
      // Fallback reference if Storage bucket permissions aren't enabled yet
      setUploadedProofName(file.name);
      setUploadedProofUrl(`attached:${file.name} (${Math.round(file.size / 1024)}KB)`);
      setMsg(`Attached proof metadata for ${file.name}.`);
    } finally {
      setUploadingFile(false);
    }
  };

  const handleSubmitProof = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTask) return;
    await handleStatusTransition(
      selectedTask,
      'Pending Approval',
      {
        progressPct: 100,
        completionNotes: proofNotes.trim() || 'Task completed',
        ...(uploadedProofUrl ? { completionProofUrl: uploadedProofUrl } : {}),
      },
      `Submitted completion proof: ${proofNotes.trim() || 'Done'}`
    );
    setProofNotes('');
    setUploadedProofUrl('');
    setUploadedProofName('');
    setProgressInput(100);
  };

  const handleRequestExtension = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTask || !extDate || !extReason.trim()) return;
    try {
      await updateDoc(doc(db, 'tasks', selectedTask.id), {
        extensionRequestedDate: extDate,
        extensionReason: extReason.trim(),
        updatedAt: serverTimestamp(),
      });
      await addTaskUpdateLog(
        selectedTask,
        'Extension Requested',
        `Requested new deadline ${extDate}: ${extReason.trim()}`
      );
      await pushNotification({
        recipientUid: selectedTask.createdByUid,
        title: `Deadline Extension Request: ${selectedTask.title}`,
        message: `${currentUser.displayName} requested ${extDate} (${extReason.trim()})`,
        category: 'Task',
        severity: 'warning',
      });
      setExtDate('');
      setExtReason('');
      setMsg('Deadline extension request sent.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `tasks/${selectedTask.id}`);
    }
  };

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== 'ALL' && t.status !== statusFilter) return false;
      if (categoryFilter !== 'ALL' && t.category !== categoryFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          t.title.toLowerCase().includes(q) ||
          t.assignedToName.toLowerCase().includes(q) ||
          (t.teamName || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [tasks, statusFilter, categoryFilter, search]);

  const performanceByEmployee = useMemo(() => {
    const map = new Map<
      string,
      { name: string; total: number; completed: number; overdue: number }
    >();
    tasks.forEach((t) => {
      const cur = map.get(t.assignedToUid) || {
        name: t.assignedToName,
        total: 0,
        completed: 0,
        overdue: 0,
      };
      cur.total += 1;
      if (['Completed', 'Approved'].includes(t.status)) cur.completed += 1;
      if (t.status === 'Overdue') cur.overdue += 1;
      map.set(t.assignedToUid, cur);
    });
    return Array.from(map.values());
  }, [tasks]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {isAdminView ? 'Task Assignment & Execution' : 'My Assigned Tasks'}
          </h2>
          <p className="text-xs text-slate-500">
            Assign field tasks, track progress milestones, submit proof, and verify completion.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {isAdminView && (
            <>
              <button
                type="button"
                onClick={() => setShowPerformance((v) => !v)}
                className="px-3.5 py-2 text-xs font-medium text-[#0F2744] bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
              >
                {showPerformance ? 'Hide Performance' : 'Employee Performance'}
              </button>
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg min-h-[40px]"
              >
                <Plus className="w-4 h-4" />
                Assign Task
              </button>
            </>
          )}
        </div>
      </div>

      {msg && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
          {msg}
        </div>
      )}

      {isAdminView && savedAssignDraftMeta && !showCreateModal && (
        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-amber-900">
            <span className="font-semibold">Unsaved task draft preserved locally</span>
            <span className="text-amber-800">
              {' '}
              — {savedAssignDraftMeta.title || 'Untitled task'} ({savedAssignDraftMeta.category}
              {savedAssignDraftMeta.assigneeCount > 0
                ? `, ${savedAssignDraftMeta.assigneeCount} assignee(s)`
                : ''}
              ) · saved {formatDraftAge(savedAssignDraftMeta.savedAt)}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openCreate}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-[#0F2744] hover:bg-[#16355C] rounded-lg"
            >
              Resume Draft
            </button>
            <button
              type="button"
              onClick={() => {
                clearFormDraft(getTaskAssignDraftKey(currentUser.uid));
                setSavedAssignDraftMeta(null);
              }}
              className="px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 rounded-lg"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {isAdminView && showPerformance && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            Employee-wise Task Performance
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-medium">Employee</th>
                  <th className="py-2 font-medium text-right">Assigned</th>
                  <th className="py-2 font-medium text-right">Completed</th>
                  <th className="py-2 font-medium text-right">Overdue</th>
                  <th className="py-2 font-medium text-right">Completion Rate</th>
                </tr>
              </thead>
              <tbody>
                {performanceByEmployee.map((row) => (
                  <tr key={row.name} className="border-b border-slate-100">
                    <td className="py-2.5 font-medium text-slate-900">{row.name}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{row.total}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-[#15803D]">
                      {row.completed}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-red-700">
                      {row.overdue}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums font-semibold">
                      {row.total ? Math.round((row.completed / row.total) * 100) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Search & Filter */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks by title, assignee, or team..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
        >
          <option value="ALL">All Categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
        >
          <option value="ALL">All Statuses</option>
          {[
            'Assigned',
            'Accepted',
            'In Progress',
            'Completed',
            'Pending Approval',
            'Approved',
            'Rejected',
            'Overdue',
            'Cancelled',
          ].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Tasks List */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <ClipboardList className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <div className="text-sm font-medium text-slate-700">No tasks found</div>
          <p className="text-xs text-slate-400 mt-1">
            {isAdminView
              ? 'Assign a task to get started.'
              : 'No tasks assigned under the current filters.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((t) => (
            <div
              key={t.id}
              className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3"
            >
              <div>
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500 mb-1.5">
                  <span>
                    {t.category} · {t.priority} Priority
                  </span>
                  <span
                    className={`font-semibold ${
                      t.status === 'Approved' || t.status === 'Completed'
                        ? 'text-[#15803D]'
                        : t.status === 'Overdue' || t.status === 'Rejected'
                        ? 'text-red-700'
                        : 'text-[#0F2744]'
                    }`}
                  >
                    {t.status}
                  </span>
                </div>
                <h3 className="text-sm font-bold text-slate-900">{t.title}</h3>
                {t.description && (
                  <p className="text-xs text-slate-600 mt-1 line-clamp-2">{t.description}</p>
                )}
              </div>

              <div className="space-y-2.5 pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    Assignee: <strong className="text-slate-800">{t.assignedToName}</strong>
                  </span>
                  <span className="font-mono">Due {t.deadline}</span>
                </div>

                <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#15803D] rounded-full"
                    style={{ width: `${t.progressPct || 0}%` }}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  {(() => {
                    void detailDraftVersion;
                    const storedDetail = loadFormDraft<TaskDetailDraft>(
                      getTaskDetailDraftKey(currentUser.uid, t.id)
                    );
                    const hasSavedDetailDraft = Boolean(
                      storedDetail &&
                        hasTaskDetailDraftContent(
                          storedDetail.data,
                          t.progressPct || 50
                        )
                    );
                    return (
                      <button
                        type="button"
                        onClick={() => openTaskDetail(t)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                          hasSavedDetailDraft
                            ? 'text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300'
                            : 'text-[#0F2744] bg-slate-100 hover:bg-slate-200'
                        }`}
                      >
                        {hasSavedDetailDraft
                          ? 'Resume Draft Update'
                          : 'Open & Update'}
                      </button>
                    );
                  })()}

                  {isAdminView && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEdit(t)}
                        className="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                      >
                        Edit / Reassign
                      </button>
                      {t.status !== 'Cancelled' && t.status !== 'Approved' && (
                        <button
                          type="button"
                          onClick={() =>
                            handleStatusTransition(t, 'Cancelled', {}, 'Cancelled by Admin')
                          }
                          className="px-2.5 py-1.5 text-xs text-red-700 hover:bg-red-50 rounded-lg"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Assign / Edit Task Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editingTask ? 'Edit / Reassign Task' : 'Assign New Operational Task'}
              </h3>
              <button
                type="button"
                onClick={closeCreateModal}
                className="p-1.5 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {(assignDraftRestored || assignDraftSavedAt) && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span>
                  {assignDraftRestored
                    ? 'Draft restored from local cache'
                    : 'Auto-saved to device'}
                  {assignDraftSavedAt
                    ? ` · ${formatDraftAge(assignDraftSavedAt)}`
                    : ''}
                </span>
                <button
                  type="button"
                  onClick={handleDiscardAssignDraft}
                  className="text-xs font-medium text-red-700 hover:underline"
                >
                  {editingTask ? 'Revert to Saved' : 'Discard Draft'}
                </button>
              </div>
            )}

            {err && (
              <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
                {err}
              </div>
            )}

            <form onSubmit={handleSaveTask} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Task Title
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Category
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as TaskCategory)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Priority
                  </label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as TaskPriority)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Assign To Employee(s) {editingTask ? '(Single)' : '(Multi-select supported)'}
                </label>
                <div className="max-h-36 overflow-y-auto border border-slate-300 rounded-lg p-2 space-y-1">
                  {assignableEmployees.map((emp) => {
                    const uid = emp.uid || emp.id;
                    const checked = selectedAssigneeUids.includes(uid);
                    return (
                      <label
                        key={emp.id}
                        className="flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer"
                      >
                        <input
                          type={editingTask ? 'radio' : 'checkbox'}
                          checked={checked}
                          onChange={() => {
                            if (editingTask) {
                              setSelectedAssigneeUids([uid]);
                            } else {
                              setSelectedAssigneeUids((prev) =>
                                prev.includes(uid)
                                  ? prev.filter((x) => x !== uid)
                                  : [...prev, uid]
                              );
                            }
                          }}
                        />
                        <span className="font-medium text-slate-900">{emp.fullName}</span>
                        <span className="text-slate-400">
                          ({emp.designation || getRoleDisplayLabel(emp.role)})
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Team / Group Label
                  </label>
                  <input
                    type="text"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder="e.g. West Field Team"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    required
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Deadline
                  </label>
                  <input
                    type="date"
                    required
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Description & Instructions
                </label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Task context and deliverables..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg mb-2"
                />
                <input
                  type="text"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Field execution instructions..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Admin Remarks
                </label>
                <input
                  type="text"
                  value={adminRemarks}
                  onChange={(e) => setAdminRemarks(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeCreateModal}
                  className="px-4 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                >
                  {saving ? 'Saving...' : editingTask ? 'Update Task' : 'Assign Task'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Task Execution / Approval Detail Modal */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs text-slate-500">
                  {selectedTask.category} · {selectedTask.priority} · Due {selectedTask.deadline}
                </div>
                <h3 className="text-base font-bold text-slate-900 mt-0.5">
                  {selectedTask.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeDetailModal}
                className="p-1.5 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {(detailDraftRestored || detailDraftSavedAt) && (
              <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span>
                  {detailDraftRestored
                    ? 'Task update draft restored from local cache'
                    : 'Progress inputs auto-saved locally'}
                  {detailDraftSavedAt
                    ? ` · ${formatDraftAge(detailDraftSavedAt)}`
                    : ''}
                </span>
                <button
                  type="button"
                  onClick={handleDiscardDetailDraft}
                  className="text-xs font-medium text-red-700 hover:underline"
                >
                  Discard Draft
                </button>
              </div>
            )}

            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
              <div>
                <strong>Status:</strong> {selectedTask.status} ({selectedTask.progressPct || 0}%)
              </div>
              <div>
                <strong>Assigned To:</strong> {selectedTask.assignedToName}
              </div>
              {selectedTask.instructions && (
                <div>
                  <strong>Instructions:</strong> {selectedTask.instructions}
                </div>
              )}
              {selectedTask.completionProofUrl && (
                <div>
                  <strong>Proof:</strong> {selectedTask.completionProofUrl}
                </div>
              )}
            </div>

            {/* Employee Execution Controls */}
            {!['Approved', 'Cancelled'].includes(selectedTask.status) && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {selectedTask.status === 'Assigned' && (
                    <button
                      type="button"
                      onClick={() =>
                        handleStatusTransition(selectedTask, 'Accepted', { progressPct: 10 })
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                    >
                      Accept Task
                    </button>
                  )}
                  {(selectedTask.status === 'Assigned' || selectedTask.status === 'Accepted') && (
                    <button
                      type="button"
                      onClick={() =>
                        handleStatusTransition(selectedTask, 'In Progress', { progressPct: 25 })
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[#15803D] rounded-lg"
                    >
                      Start Task
                    </button>
                  )}
                </div>

                {/* Progress & Comment */}
                <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="text-xs font-semibold text-slate-800">
                    Update Progress & Comment
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={progressInput}
                      onChange={(e) => setProgressInput(Number(e.target.value))}
                      className="flex-1"
                    />
                    <span className="font-mono text-xs font-semibold w-10 text-right">
                      {progressInput}%
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Add progress note or field update..."
                      className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        await handleStatusTransition(
                          selectedTask,
                          'In Progress',
                          { progressPct: progressInput },
                          commentText.trim() || `Progress updated to ${progressInput}%`
                        );
                        setCommentText('');
                      }}
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[#0F2744] rounded-lg"
                    >
                      Save Update
                    </button>
                  </div>
                </div>

                {/* Submit Completion Proof */}
                <form
                  onSubmit={handleSubmitProof}
                  className="border border-slate-200 rounded-xl p-4 space-y-3"
                >
                  <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-[#15803D]" />
                    Submit Completion Proof & Mark Completed
                  </div>
                  <input
                    type="text"
                    value={proofNotes}
                    onChange={(e) => setProofNotes(e.target.value)}
                    placeholder="Completion summary (e.g. Order collected, signed receipt attached)"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer">
                      <Upload className="w-3.5 h-3.5" />
                      <span>
                        {uploadingFile
                          ? 'Uploading...'
                          : uploadedProofName || 'Upload Photo / Document'}
                      </span>
                      <input type="file" onChange={handleProofUpload} className="hidden" />
                    </label>
                    <button
                      type="submit"
                      className="px-4 py-2 text-xs font-semibold text-white bg-[#15803D] hover:bg-[#166534] rounded-lg"
                    >
                      Submit for Approval
                    </button>
                  </div>
                </form>

                {/* Request Deadline Extension */}
                <form
                  onSubmit={handleRequestExtension}
                  className="border border-slate-200 rounded-xl p-4 space-y-2"
                >
                  <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-amber-600" />
                    Request Deadline Extension
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      type="date"
                      value={extDate}
                      onChange={(e) => setExtDate(e.target.value)}
                      className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                    <input
                      type="text"
                      value={extReason}
                      onChange={(e) => setExtReason(e.target.value)}
                      placeholder="Reason for extension..."
                      className="sm:col-span-2 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-medium text-[#0F2744] border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    Send Extension Request
                  </button>
                </form>
              </div>
            )}

            {/* Admin Verification Controls */}
            {isAdminView &&
              (selectedTask.status === 'Pending Approval' ||
                selectedTask.status === 'Completed') && (
                <div className="border border-emerald-200 bg-emerald-50/50 rounded-xl p-4 space-y-3">
                  <div className="text-xs font-semibold text-slate-900">
                    Admin Verification & Approval
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleStatusTransition(
                          selectedTask,
                          'Approved',
                          { progressPct: 100 },
                          'Approved by Admin'
                        )
                      }
                      className="px-4 py-2 text-xs font-semibold text-white bg-[#15803D] rounded-lg"
                    >
                      Approve Completion
                    </button>
                    <input
                      type="text"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Rejection reason (required to reject)..."
                      className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!rejectReason.trim()) return;
                        handleStatusTransition(
                          selectedTask,
                          'Rejected',
                          { rejectionReason: rejectReason.trim() },
                          `Rejected: ${rejectReason.trim()}`
                        );
                        setRejectReason('');
                      }}
                      className="px-4 py-2 text-xs font-semibold text-white bg-red-700 rounded-lg"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

            {/* Task Updates History */}
            <div>
              <h4 className="text-xs font-semibold text-slate-800 mb-2 flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" />
                Task Timeline & Comments
              </h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {taskUpdates
                  .filter((u) => u.taskId === selectedTask.id)
                  .map((u) => (
                    <div
                      key={u.id}
                      className="p-2.5 rounded-lg border border-slate-100 bg-slate-50 text-xs"
                    >
                      <div className="flex justify-between text-slate-500">
                        <span className="font-semibold text-slate-800">
                          {u.authorName} · {u.actionType}
                        </span>
                        <span className="font-mono">{formatTimestamp(u.createdAt)}</span>
                      </div>
                      <p className="text-slate-600 mt-0.5">{u.comment}</p>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
